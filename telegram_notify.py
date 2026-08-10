#!/usr/bin/env python3
"""Telegram notifications — outbound only.

Two triggers:

  1. A marked volume bar on 5m: total volume >= N x its own MA20 *and* one
     side took >= X% of the aggression. Both halves are required — a 3x bar
     at 55/45 is noise, not a signal.
  2. A high-importance macro release coming up within N minutes.

The bot token is never returned to the browser; /api/telegram/config reports
only a masked tail and whether a token is set. The config file lives in the
project root rather than under lightweight/, js/ or css/, all of which are
served as static directories.
"""

import os
import io
import json
import time
import logging
import threading
import datetime as dt
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle

log = logging.getLogger(__name__)

API = "https://api.telegram.org/bot{token}/{method}"

DEFAULT_CONFIG = {
    "enabled": False,
    "token": "",
    "chat_id": "",
    "symbol": "BTCUSDT",
    "interval": "5m",
    # Volume rule. Defaults measured against 500 live 5m bars: the original
    # 3x / 80-20 never fired once, because buyRatio on a 5m BTC perp bar only
    # spans ~0.27..0.73. 2.0x / 70-30 marks ~9 bars per 500 (~1 per 4.5h).
    "vol_multiple": 2.0,
    "vol_buy_ratio": 0.70,
    "vol_ma_length": 20,
    "notify_volume": True,
    "notify_macro": True,
    "macro_lead_minutes": 15,
    "notify_macro_actual": True,
    # A release found with an actual value already older than this is
    # something the bot only just started watching (e.g. right after a
    # restart), not something that "just printed" — skip it rather than
    # dump days of history the moment the process comes up.
    "macro_actual_grace_minutes": 180,
}

# Indicator table rendering — thresholds mirror TH/getState in js/main.js so
# the picture and the dashboard can never disagree about a cell's colour.
TH = {
    "wtmo":  {"ob": 60,  "os": -60,  "obn": 45,  "osn": -45},
    "mlmi":  {"ob": 70,  "os": -70,  "obn": 50,  "osn": -50},
    "rsi":   {"ob": 80,  "os": 20,   "obn": 70,  "osn": 30},
    "mfi":   {"ob": 85,  "os": 15,   "obn": 75,  "osn": 25},
    "cci":   {"ob": 120, "os": -120, "obn": 80,  "osn": -80},
    "willr": {"ob": -10, "os": -90,  "obn": -20, "osn": -80},
    "uo":    {"ob": 60,  "os": 40,   "obn": 55,  "osn": 45},
    "adx":   {"l1": 20, "l2": 30, "l3": 40},
    "dmp":   {"l1": 20, "l2": 30, "l3": 40},
    "dmm":   {"l1": 20, "l2": 30, "l3": 40},
    "cmf":   {"bull": 0.2, "bear": -0.2},
}
STATE_COLOR = {
    "ob": "#7f1d1d", "ob-near": "#4a1414",
    "os": "#14532d", "os-near": "#0f3320",
    "adx-l1": "#3a2f10", "adx-l2": "#5a4715", "adx-l3": "#7a5f1a",
    "bull": "#14532d", "bear": "#7f1d1d",
    "neutral": "#161a20",
}
TABLE_COLS = [
    ("wt1", "WTMO", "wtmo", 1), ("mlmi", "MLMI", "mlmi", 1),
    ("rsi", "RSI", "rsi", 1), ("mfi", "MFI", "mfi", 1),
    ("cci", "CCI", "cci", 0), ("willr", "W%R", "willr", 1),
    ("uo", "UO", "uo", 1), ("adx", "ADX", "adx", 1),
    ("dmp", "DM+", "dmp", 1), ("dmm", "DM-", "dmm", 1),
    ("cmf", "CMF", "cmf", 3),
]


def cell_state(th_key, value):
    if value is None:
        return "neutral"
    th = TH.get(th_key)
    if not th:
        return "neutral"
    if "bull" in th:
        if value >= th["bull"]:
            return "bull"
        if value <= th["bear"]:
            return "bear"
        return "neutral"
    if "l1" in th:
        if value >= th["l3"]:
            return "adx-l3"
        if value >= th["l2"]:
            return "adx-l2"
        if value >= th["l1"]:
            return "adx-l1"
        return "neutral"
    if value >= th["ob"]:
        return "ob"
    if value >= th["obn"]:
        return "ob-near"
    if value <= th["os"]:
        return "os"
    if value <= th["osn"]:
        return "os-near"
    return "neutral"


class TelegramNotifier:
    def __init__(self, config_path: str, data_provider, macro=None):
        """`data_provider(tf)` returns the same dict /api/data/<tf> serves."""
        self.config_path = config_path
        self.data_provider = data_provider
        self.macro = macro
        self._lock = threading.Lock()
        self.config = dict(DEFAULT_CONFIG)
        self.load()
        self._stop = False
        self.last_error: str | None = None
        self.last_sent: float | None = None
        # Volume-signal state
        self._last_signal_bar = 0
        # Macro alerts already announced
        self._macro_alerted: set[str] = set()
        # Macro actual-result alerts already sent (or deliberately skipped as
        # stale) — each event id is added at most once, ever.
        self._macro_actual_sent: set[str] = set()

    # ── config ──────────────────────────────────────────────────────────
    def load(self):
        try:
            if os.path.exists(self.config_path):
                with open(self.config_path, encoding="utf-8") as fh:
                    saved = json.load(fh)
                merged = dict(DEFAULT_CONFIG)
                merged.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
                self.config = merged
        except Exception as e:
            log.warning("[tg] could not read config: %s", e)

    def save(self):
        tmp = self.config_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.config, fh, indent=2)
        os.replace(tmp, self.config_path)

    def public_config(self) -> dict:
        """Config safe to hand to a browser: the token never leaves the server,
        only a masked tail so the UI can show that one is stored."""
        c = dict(self.config)
        tok = c.pop("token", "") or ""
        c["token_set"] = bool(tok)
        c["token_hint"] = ("…" + tok[-4:]) if len(tok) >= 4 else ""
        c["bot_id"] = tok.split(":")[0] if ":" in tok else ""
        return c

    def update(self, patch: dict) -> dict:
        with self._lock:
            for k, v in patch.items():
                if k not in DEFAULT_CONFIG:
                    continue
                if k == "token" and not str(v).strip():
                    continue          # empty token field means "keep existing"
                self.config[k] = v
            self.save()
        return self.public_config()

    # ── transport ───────────────────────────────────────────────────────
    def _call(self, method: str, params: dict):
        """Plain form-encoded call. File uploads go through _multipart."""
        token = self.config.get("token", "").strip()
        if not token:
            raise RuntimeError("no bot token configured")
        body = urlencode({k: v for k, v in params.items() if v is not None}).encode()
        req = Request(API.format(token=token, method=method), data=body,
                      headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urlopen(req, timeout=30) as r:
            payload = json.load(r)
        if not payload.get("ok"):
            raise RuntimeError(payload.get("description", "telegram error"))
        return payload["result"]

    def _multipart(self, method: str, params: dict, field: str, filename: str, blob: bytes):
        token = self.config.get("token", "").strip()
        if not token:
            raise RuntimeError("no bot token configured")
        boundary = "----cdx" + str(int(time.time() * 1000))
        buf = io.BytesIO()
        for k, v in params.items():
            if v is None:
                continue
            buf.write(f"--{boundary}\r\n".encode())
            buf.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
            buf.write(f"{v}\r\n".encode("utf-8"))
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
            f"Content-Type: image/png\r\n\r\n".encode()
        )
        buf.write(blob)
        buf.write(f"\r\n--{boundary}--\r\n".encode())

        req = Request(
            API.format(token=token, method=method),
            data=buf.getvalue(),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urlopen(req, timeout=60) as r:
            payload = json.load(r)
        if not payload.get("ok"):
            raise RuntimeError(payload.get("description", "telegram error"))
        return payload["result"]

    def send_message(self, text: str, **kw):
        return self._call("sendMessage", {
            "chat_id": self.config["chat_id"], "text": text,
            "parse_mode": "HTML", "disable_web_page_preview": "true", **kw})

    def send_photo(self, png: bytes, caption: str):
        return self._multipart("sendPhoto", {
            "chat_id": self.config["chat_id"], "caption": caption[:1024],
            "parse_mode": "HTML"}, "photo", "signal.png", png)

    def detect_chat_id(self) -> dict:
        """Read getUpdates and pick the most recent private chat.

        Needed because the number in front of the colon in a bot token is the
        *bot's* own id — sending to it fails. The human's chat id is a
        different number, and only shows up once they message the bot.
        """
        updates = self._call("getUpdates", {"limit": 20, "timeout": 0})
        found = []
        for u in updates:
            msg = u.get("message") or u.get("channel_post") or {}
            chat = msg.get("chat") or {}
            if chat.get("id") is not None:
                found.append({
                    "id": chat["id"], "type": chat.get("type"),
                    "name": chat.get("username") or chat.get("title")
                            or " ".join(filter(None, [chat.get("first_name"),
                                                      chat.get("last_name")])),
                })
        seen, uniq = set(), []
        for f in found:
            if f["id"] not in seen:
                seen.add(f["id"])
                uniq.append(f)
        return {"chats": uniq[::-1], "updates": len(updates)}

    def get_me(self) -> dict:
        return self._call("getMe", {})

    # ── volume rule ─────────────────────────────────────────────────────
    def evaluate_bars(self, ohlcv: list[dict]) -> list[dict]:
        """Mark every bar the rule fires on. Same arithmetic as _renderVolume
        in js/main.js, so a marked bar in Telegram is a marked bar on screen."""
        n = int(self.config["vol_ma_length"])
        mult = float(self.config["vol_multiple"])
        hi = float(self.config["vol_buy_ratio"])
        lo = 1.0 - hi

        marks = []
        for i, b in enumerate(ohlcv):
            win = ohlcv[max(0, i - n + 1): i + 1]
            ma = sum(x["volume"] for x in win) / len(win) if win else 0.0
            if ma <= 0 or b["volume"] < mult * ma:
                continue
            # Buy% = where close sits within the bar's own high-low range —
            # VOLUDE.PINE's formula (matches js/main.js _renderVolume), not
            # taker_buy/volume. Using the old taker-flow ratio here made this
            # rule fire far less often than the on-chart colouring it's
            # supposed to mirror, so real spikes never reached Telegram.
            rng = b["high"] - b["low"]
            buy_pct = (b["close"] - b["low"]) / rng if rng else 0.5
            side = "BUY" if buy_pct >= hi else ("SELL" if buy_pct <= lo else None)
            if side:
                marks.append({"index": i, "time": b["time"], "side": side,
                              "ratio": buy_pct, "multiple": b["volume"] / ma,
                              "volume": b["volume"], "close": b["close"]})
        return marks

    # ── picture ─────────────────────────────────────────────────────────
    def render_png(self, tf_payloads: dict, mark: dict, bars_shown: int = 70) -> bytes:
        """One image: 5m candles on top, volume with its MA in the middle,
        the 6-timeframe indicator table underneath."""
        base = tf_payloads[self.config["interval"]]
        ohlcv = base["ohlcv"][-bars_shown:]
        n = int(self.config["vol_ma_length"])
        full = base["ohlcv"]
        offset = len(full) - len(ohlcv)

        fig = plt.figure(figsize=(12, 11), facecolor="#0b0e13")
        gs = fig.add_gridspec(3, 1, height_ratios=[3.1, 1.25, 2.4], hspace=0.12,
                              left=0.055, right=0.985, top=0.955, bottom=0.03)
        ax_p, ax_v, ax_t = fig.add_subplot(gs[0]), fig.add_subplot(gs[1]), fig.add_subplot(gs[2])

        for ax in (ax_p, ax_v):
            ax.set_facecolor("#0b0e13")
            for s in ax.spines.values():
                s.set_color("#222831")
            ax.tick_params(colors="#8b93a3", labelsize=8)
            ax.grid(color="#161a20", linewidth=0.6)
            ax.set_axisbelow(True)

        # Candles
        for i, b in enumerate(ohlcv):
            up = b["close"] >= b["open"]
            col = "#26a69a" if up else "#ef5350"
            ax_p.plot([i, i], [b["low"], b["high"]], color=col, linewidth=0.8, zorder=2)
            lo_, h = min(b["open"], b["close"]), abs(b["close"] - b["open"]) or 1e-9
            ax_p.add_patch(Rectangle((i - 0.32, lo_), 0.64, h, facecolor=col,
                                     edgecolor=col, linewidth=0.5, zorder=3))

        mark_i = mark["index"] - offset
        if 0 <= mark_i < len(ohlcv):
            ax_p.axvline(mark_i, color="#ffb300", linewidth=1.1, linestyle="--",
                         alpha=0.85, zorder=1)

        ax_p.set_xlim(-1, len(ohlcv))
        ax_p.set_ylabel("price", color="#8b93a3", fontsize=9)
        arrow = "BUY" if mark["side"] == "BUY" else "SELL"
        ax_p.set_title(
            f"{base.get('instrument', '')}  ·  {self.config['interval']}  ·  "
            f"{arrow} volume spike   {mark['multiple']:.1f}x MA{n}   "
            f"buy% {mark['ratio'] * 100:.0f}%",
            color="#e6e9ef", fontsize=12, pad=10)

        # Volume + MA
        vols = [b["volume"] for b in ohlcv]
        for i, b in enumerate(ohlcv):
            gi = i + offset
            win = full[max(0, gi - n + 1): gi + 1]
            ma = sum(x["volume"] for x in win) / len(win)
            rng = b["high"] - b["low"]
            buy_pct = (b["close"] - b["low"]) / rng if rng else 0.5
            spike = b["volume"] >= float(self.config["vol_multiple"]) * ma
            hi = float(self.config["vol_buy_ratio"])
            if spike and buy_pct >= hi:
                col = "#26a69a"
            elif spike and buy_pct <= 1 - hi:
                col = "#ef5350"
            else:
                col = "#5a6273"
            ax_v.bar(i, b["volume"], width=0.64, color=col, zorder=3)

        ma_line = []
        for i in range(len(ohlcv)):
            gi = i + offset
            win = full[max(0, gi - n + 1): gi + 1]
            ma_line.append(sum(x["volume"] for x in win) / len(win))
        ax_v.plot(range(len(ohlcv)), ma_line, color="#f7931a", linewidth=1.4,
                  label=f"MA{n}", zorder=4)
        ax_v.legend(loc="upper left", fontsize=8, facecolor="#11151b",
                    edgecolor="#222831", labelcolor="#8b93a3")
        ax_v.set_xlim(-1, len(ohlcv))
        # The MA carries volume from bars to the left of the window and can sit
        # above every bar shown, so it has to be in the limit too or the line
        # runs off the top of the panel.
        ax_v.set_ylim(0, max(max(vols), max(ma_line)) * 1.12)
        ax_v.set_ylabel("volume", color="#8b93a3", fontsize=9)

        # Indicator table
        ax_t.axis("off")
        tfs = [t for t in ("5m", "15m", "30m", "1h", "4h", "1d") if t in tf_payloads]
        ncol = len(TABLE_COLS) + 1
        cw, ch = 1.0 / ncol, 1.0 / (len(tfs) + 1)

        for j, (_, label, _, _) in enumerate([("", "TF", "", 0)] + TABLE_COLS):
            ax_t.add_patch(Rectangle((j * cw, 1 - ch), cw, ch, facecolor="#11151b",
                                     edgecolor="#222831", linewidth=0.6,
                                     transform=ax_t.transAxes))
            ax_t.text(j * cw + cw / 2, 1 - ch / 2, label, ha="center", va="center",
                      color="#8b93a3", fontsize=9, fontweight="bold",
                      transform=ax_t.transAxes)

        for r, tf in enumerate(tfs):
            y = 1 - (r + 2) * ch
            ind = tf_payloads[tf].get("indicators", {})
            last = len(tf_payloads[tf].get("ohlcv", [])) - 1
            ax_t.add_patch(Rectangle((0, y), cw, ch, facecolor="#11151b",
                                     edgecolor="#222831", linewidth=0.6,
                                     transform=ax_t.transAxes))
            ax_t.text(cw / 2, y + ch / 2, tf, ha="center", va="center",
                      color="#e6e9ef", fontsize=9, fontweight="bold",
                      transform=ax_t.transAxes)
            for j, (key, _, th_key, digits) in enumerate(TABLE_COLS, start=1):
                seq = ind.get(key) or []
                val = seq[last] if 0 <= last < len(seq) else None
                state = cell_state(th_key, val)
                ax_t.add_patch(Rectangle((j * cw, y), cw, ch,
                                         facecolor=STATE_COLOR[state],
                                         edgecolor="#222831", linewidth=0.6,
                                         transform=ax_t.transAxes))
                txt = "—" if val is None else f"{val:.{digits}f}"
                ax_t.text(j * cw + cw / 2, y + ch / 2, txt, ha="center", va="center",
                          color="#e6e9ef", fontsize=8.5, transform=ax_t.transAxes)

        buf = io.BytesIO()
        fig.savefig(buf, format="png", facecolor="#0b0e13", dpi=105)
        plt.close(fig)
        return buf.getvalue()

    # ── captions ────────────────────────────────────────────────────────
    @staticmethod
    def _caption(mark: dict, cfg: dict) -> str:
        icon = "🟢" if mark["side"] == "BUY" else "🔴"
        when = dt.datetime.fromtimestamp(mark["time"])  # local system time, not UTC
        head = f"{icon} <b>{mark['side']} volume spike</b> · {cfg['symbol']} {cfg['interval']}"
        return (
            f"{head}\n"
            f"<code>price      {mark['close']:,.2f}\n"
            f"volume     {mark['multiple']:.2f}x MA{cfg['vol_ma_length']}\n"
            f"buy %      {mark['ratio'] * 100:.1f}%\n"
            f"bar close  {when:%Y-%m-%d %H:%M}</code>"
        )

    # ── run loop ────────────────────────────────────────────────────────
    def _check_volume(self):
        cfg = self.config
        payloads = {tf: self.data_provider(tf)
                    for tf in ("5m", "15m", "30m", "1h", "4h", "1d")}
        base = payloads.get(cfg["interval"])
        if not base or not base.get("ohlcv"):
            return

        # Closed bars only. A forming bar's volume grows through the period and
        # can cross the multiple mid-bar then fall back, which would fire an
        # alert for a bar that never actually qualified.
        closed = base["ohlcv"][:-1]
        marks = self.evaluate_bars(closed)
        if not marks:
            return
        latest = marks[-1]
        if latest["time"] <= self._last_signal_bar:
            return

        bar_seconds = {"5m": 300, "15m": 900, "30m": 1800,
                       "1h": 3600, "4h": 14400, "1d": 86400}[cfg["interval"]]

        # Only alert on a bar that closed just now. The payload carries 500
        # bars, so without this the first pass after enabling (or after a
        # restart) would fire on whatever the most recent historical mark was
        # — possibly hours stale — and present it as a live signal.
        age = time.time() - (latest["time"] + bar_seconds)
        if age > 2 * bar_seconds:
            self._last_signal_bar = latest["time"]
            log.info("[tg] skipping stale mark (%.0f min old)", age / 60)
            return
        png = self.render_png(payloads, latest)
        self.send_photo(png, self._caption(latest, cfg))

        self._last_signal_bar = latest["time"]
        self.last_sent = time.time()
        log.info("[tg] volume signal sent: %s %s", latest["side"], latest["time"])

    def check_live_volume(self, tf: str) -> dict:
        """Instant path: the browser pokes this the moment a still-forming
        bar's on-chart colour crosses a signal threshold — no waiting for
        the bar to close. Only acts on `cfg["interval"]` (the single
        timeframe render_png/_caption are built around); a poke for any
        other tf is a no-op so the picture never gets built from one tf's
        payload while labelled with another's mark.

        Shares `_last_signal_bar` with `_check_volume`'s closed-bar path —
        whichever fires first for a bar wins, so a bar never gets alerted
        twice (once live, once again after it closes)."""
        cfg = self.config
        if tf != cfg.get("interval"):
            return {"marked": False}
        if not (cfg.get("enabled") and cfg.get("chat_id") and cfg.get("notify_volume")):
            return {"marked": False}

        base = self.data_provider(tf)
        ohlcv = base.get("ohlcv") if base else None
        if not ohlcv:
            return {"marked": False}

        last = ohlcv[-1]
        if last["time"] <= self._last_signal_bar:
            return {"marked": False}

        marks = self.evaluate_bars(ohlcv)
        if not marks or marks[-1]["time"] != last["time"]:
            return {"marked": False}
        latest = marks[-1]

        payloads = {t: self.data_provider(t)
                    for t in ("5m", "15m", "30m", "1h", "4h", "1d")}
        png = self.render_png(payloads, latest)
        self.send_photo(png, self._caption(latest, cfg))

        self._last_signal_bar = latest["time"]
        self.last_sent = time.time()
        log.info("[tg] LIVE volume signal sent: %s %s", latest["side"], latest["time"])
        return {"marked": True, "sent": True}

    def _check_macro(self):
        if not self.macro:
            return
        lead = int(self.config["macro_lead_minutes"]) * 60
        for e in self.macro.next_upcoming(lead):
            if e["id"] in self._macro_alerted:
                continue
            mins = max(0, int((e["ts"] - time.time()) / 60))
            when = dt.datetime.fromtimestamp(e["ts"])  # local system time, not UTC
            meta = e.get("meta") or {}
            lines = [
                f"📅 <b>{e['title']}</b> in {mins} min",
                f"<code>{when:%H:%M} · {e.get('country', '')}</code>",
            ]
            vals = []
            for label, key in (("forecast", "forecast"), ("previous", "previous")):
                if e.get(key) is not None:
                    vals.append(f"{label} {e[key]}{e.get('unit') or ''}")
            if vals:
                lines.append("<code>" + " · ".join(vals) + "</code>")
            if meta.get("power_crypto"):
                lines.append(f"crypto impact: {meta['power_crypto']}/5")
            if meta.get("criterion"):
                lines.append(f"<i>{str(meta['criterion'])[:220]}</i>")
            self.send_message("\n".join(lines))
            self._macro_alerted.add(e["id"])
            self.last_sent = time.time()
            log.info("[tg] macro alert sent: %s", e["title"])

    def _check_macro_actual(self):
        """Fires once a scheduled release's `actual` value shows up (macro.py
        refreshes from TradingView every 15 min), separate from _check_macro's
        BEFORE-the-release heads-up. Idempotent: every event id is marked seen
        the first time its actual is non-null, whether or not that also sends
        a message, so nothing is ever re-evaluated or re-sent."""
        if not self.macro:
            return
        now = time.time()
        grace = int(self.config.get("macro_actual_grace_minutes", 180)) * 60
        for e in self.macro.all():
            if e["id"] in self._macro_actual_sent or e.get("actual") is None:
                continue
            self._macro_actual_sent.add(e["id"])
            age = now - e["ts"]
            if not (0 <= age <= grace):
                continue  # already had its actual before we started watching

            when = dt.datetime.fromtimestamp(e["ts"])  # local system time, not UTC
            meta = e.get("meta") or {}
            unit = e.get("unit") or ""
            actual, forecast, previous = e["actual"], e.get("forecast"), e.get("previous")

            arrow = ""
            if forecast is not None:
                arrow = " 🟢▲" if actual > forecast else " 🔴▼" if actual < forecast else " ⚪"

            lines = [
                f"📊 <b>{e['title']}</b>{arrow}",
                f"<code>{when:%H:%M} · {e.get('country', '')}</code>",
            ]
            vals = [f"actual {actual}{unit}"]
            if forecast is not None: vals.append(f"forecast {forecast}{unit}")
            if previous is not None: vals.append(f"previous {previous}{unit}")
            lines.append("<code>" + " · ".join(vals) + "</code>")
            if meta.get("power_crypto"):
                lines.append(f"crypto impact: {meta['power_crypto']}/5")
            if actual > (forecast if forecast is not None else actual) and meta.get("if_up"):
                lines.append(f"<i>{str(meta['if_up'])[:220]}</i>")
            elif actual < (forecast if forecast is not None else actual) and meta.get("if_down"):
                lines.append(f"<i>{str(meta['if_down'])[:220]}</i>")

            self.send_message("\n".join(lines))
            self.last_sent = time.time()
            log.info("[tg] macro actual sent: %s = %s", e["title"], actual)

    def _loop(self):
        while not self._stop:
            time.sleep(20)
            if not self.config.get("enabled") or not self.config.get("chat_id"):
                continue
            try:
                if self.config.get("notify_volume"):
                    self._check_volume()
                if self.config.get("notify_macro"):
                    self._check_macro()
                if self.config.get("notify_macro_actual"):
                    self._check_macro_actual()
                self.last_error = None
            except Exception as e:
                self.last_error = str(e)
                log.warning("[tg] loop error: %s", e)

    def start(self):
        threading.Thread(target=self._loop, name="telegram-notify", daemon=True).start()
        return self

    def status(self) -> dict:
        return {
            "enabled": bool(self.config.get("enabled")),
            "tokenSet": bool(self.config.get("token")),
            "chatId": self.config.get("chat_id") or None,
            "lastSent": int(self.last_sent) if self.last_sent else None,
            "lastError": self.last_error,
            "lastSignalBar": self._last_signal_bar or None,
        }
