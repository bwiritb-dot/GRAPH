#!/usr/bin/env python3
"""
BTC-PERPETUAL Multi-Timeframe Dashboard  — Backend
Source: Binance Futures (fapi.binance.com)
Indicators: WaveTrend (WTMO) + MLMI (kNN) — logic taken from AVSBOT/indicators/indicator_worker.py
Standard: RSI · MFI · CCI · WillR · UO · CMF · ADX/DM+/DM-

Compatible: Python 3.14+  (no pandas-ta / numba)
"""

import os
import re
import math
import time
import logging
import importlib.util
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests
from flask import Flask, jsonify, request, send_from_directory, Response
from flask_cors import CORS

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__, static_folder=None)
CORS(app)

# Root of the GRAPH folder (where index.html lives)
GRAPH_DIR = os.path.dirname(os.path.abspath(__file__))
DERIBIT_ANALYZER_PATH = os.path.join(GRAPH_DIR, "Deribit Range analyzer", "fetcher.py")
COINGLASS_PATH = os.path.join(GRAPH_DIR, "Liquidations_scraper", "coinglass_analyzer.py")
_deribit_fetcher = None
_coinglass = None


# ── Static file serving ──────────────────────────────────────────────

# Shared markup fragments. The order-book depth / volume / top-traders block
# appears both at the bottom of the Futures page and on the standalone
# /lightweight view; keeping one copy on disk stops the two from drifting.
_FRAGMENTS = {
    "depth-section": os.path.join(GRAPH_DIR, "lightweight", "_depth_section.html"),
}
_INCLUDE_RE = re.compile(r"[ \t]*<!--#include\s+([a-z0-9_-]+)\s*-->[ \t]*\n?")


def render_page(directory: str, filename: str):
    """Serve an HTML file, expanding <!--#include name--> markers.

    Read fresh on every request: this is a single-user local dashboard, so
    edits show up on refresh and the cost is one small file read.
    """
    path = os.path.join(directory, filename)
    with open(path, encoding="utf-8") as fh:
        html = fh.read()

    def _sub(m):
        frag_path = _FRAGMENTS.get(m.group(1))
        if not frag_path or not os.path.exists(frag_path):
            log.error("Unknown or missing fragment: %s", m.group(1))
            return f"<!-- missing fragment: {m.group(1)} -->\n"
        with open(frag_path, encoding="utf-8") as fh:
            return fh.read()

    return Response(_INCLUDE_RE.sub(_sub, html), mimetype="text/html")


@app.get("/")
def index():
    return render_page(GRAPH_DIR, "index.html")

@app.get("/options")
def options_page():
    return send_from_directory(GRAPH_DIR, "options.html")

@app.get("/gold")
def gold_page():
    return send_from_directory(GRAPH_DIR, "gold.html")

@app.get("/lightweight")
@app.get("/orderbook")
def lightweight_page():
    return render_page(os.path.join(GRAPH_DIR, "lightweight"), "index.html")

@app.get("/lightweight/<path:filename>")
def lightweight_assets(filename):
    return send_from_directory(os.path.join(GRAPH_DIR, "lightweight"), filename)

@app.get("/css/<path:filename>")
def css(filename):
    return send_from_directory(os.path.join(GRAPH_DIR, "css"), filename)

@app.get("/js/<path:filename>")
def js(filename):
    return send_from_directory(os.path.join(GRAPH_DIR, "js"), filename)

@app.get("/assets/<path:filename>")
def assets(filename):
    return send_from_directory(os.path.join(GRAPH_DIR, "assets"), filename)


def get_deribit_fetcher():
    global _deribit_fetcher
    if _deribit_fetcher is not None:
        return _deribit_fetcher
    if not os.path.exists(DERIBIT_ANALYZER_PATH):
        raise FileNotFoundError(f"Missing Deribit analyzer: {DERIBIT_ANALYZER_PATH}")

    spec = importlib.util.spec_from_file_location("deribit_range_fetcher", DERIBIT_ANALYZER_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load Deribit analyzer from {DERIBIT_ANALYZER_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _deribit_fetcher = module
    return module


def get_coinglass():
    global _coinglass
    if _coinglass is not None:
        return _coinglass
    if not os.path.exists(COINGLASS_PATH):
        raise FileNotFoundError(f"Missing CoinGlass analyzer: {COINGLASS_PATH}")

    spec = importlib.util.spec_from_file_location("coinglass_analyzer", COINGLASS_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load CoinGlass analyzer from {COINGLASS_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    _coinglass = module
    return module

# ════════════════════════════════════════════════════════════════════
#  BINANCE FUTURES  (same as AVSBOT/indicators/indicator_worker.py)
# ════════════════════════════════════════════════════════════════════

FAPI_BASE = "https://fapi.binance.com"
KLINES    = "/fapi/v1/klines"
TICKER    = "/fapi/v1/ticker/price"
SYMBOL    = "BTCUSDT"

_session = requests.Session()
_session.headers.update({"User-Agent": "graph-dashboard/1.0"})
APP_HOST = "0.0.0.0"
APP_PORT = 5050

# Binance interval map: dashboard TF → Binance string
TF_INTERVAL = {
    "5m":  ("5m",  500),
    "15m": ("15m", 500),
    "30m": ("30m", 500),
    "1h":  ("1h",  500),
    "4h":  ("4h",  500),
    "1d":  ("1d",  365),
}

# Gold page: no real XAUUSD feed on Binance, so PAXGUSDT (a gold-backed
# token, tracks spot gold closely) is used as the price proxy — same
# Binance Futures REST/WS pattern as the rest of this dashboard.
GOLD_SYMBOL = "PAXGUSDT"
GOLD_TF_INTERVAL = {
    "15m": ("15m", 500),
    "1h":  ("1h",  500),
    "4h":  ("4h",  500),
}


def get_klines(symbol: str, interval: str, limit: int = 500) -> pd.DataFrame:
    """
    Fetch OHLCV from Binance Futures.
    Mirrors get_klines() in AVSBOT/indicators/indicator_worker.py
    """
    try:
        r = _session.get(
            FAPI_BASE + KLINES,
            params={"symbol": symbol, "interval": interval, "limit": limit},
            timeout=10,
        )
        r.raise_for_status()
        raw = r.json()
        df = pd.DataFrame(raw, columns=[
            "OpenTime", "Open", "High", "Low", "Close", "Volume",
            "CloseTime", "QuoteAssetVolume", "NumberOfTrades",
            "TakerBuyBase", "TakerBuyQuote", "Ignore",
        ])
        for col in ("Open", "High", "Low", "Close", "Volume", "TakerBuyBase"):
            df[col] = df[col].astype(float)
        df["time"] = (df["OpenTime"] // 1000).astype(int)
        return df.reset_index(drop=True)
    except Exception as e:
        log.warning("Binance klines error %s %s: %s", symbol, interval, e)
        return pd.DataFrame()


def get_price(symbol: str = SYMBOL) -> float | None:
    try:
        r = _session.get(
            FAPI_BASE + TICKER,
            params={"symbol": symbol},
            timeout=5,
        )
        r.raise_for_status()
        return float(r.json()["price"])
    except Exception as e:
        log.warning("Binance price error: %s", e)
        return None


# ════════════════════════════════════════════════════════════════════
#  ORDER BOOK DEPTH TRACKER  (backend-resident — runs from process start,
#  independent of any browser tab. Port of lightweight/app.js's client-side
#  WebSocket order-book tracker, moved server-side so history keeps
#  accumulating whether or not anyone has /lightweight open.)
# ════════════════════════════════════════════════════════════════════

import json
import sqlite3
import threading
import collections
import websocket as _wsclient  # websocket-client package (module name: websocket)

DEPTH_LEVELS      = [1, 2, 3, 5, 8, 10, 20, 40, 60]  # +/- % bands, mirrors DEPTH_COLORS keys in app.js
MAX_DEPTH_HISTORY = 86400                             # 24h of 1 Hz samples
DEPTH_RECONNECT_DELAY = 5
DEPTH_RETENTION_DAYS  = 14
DEPTH_FLUSH_SECONDS   = 5

# One SQLite file for everything that has to outlive the process: depth
# history now, marked-volume signals and Telegram state next. WAL so the
# 1 Hz writer never blocks a read from a request thread.
DB_PATH = os.path.join(GRAPH_DIR, "dashboard.db")
_db_lock = threading.Lock()


def db_connect():
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db():
    with _db_lock, db_connect() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS depth_history (
                time       INTEGER NOT NULL,
                symbol     TEXT    NOT NULL,
                price      REAL    NOT NULL,
                depths     TEXT    NOT NULL,
                crossovers TEXT    NOT NULL,
                PRIMARY KEY (symbol, time)
            )
        """)
        cutoff = int(time.time()) - DEPTH_RETENTION_DAYS * 86400
        removed = c.execute("DELETE FROM depth_history WHERE time < ?", (cutoff,)).rowcount
        if removed:
            log.info("[db] pruned %d depth rows older than %d days", removed, DEPTH_RETENTION_DAYS)


init_db()


class DepthTracker:
    """Maintains a local order book + rolling depth-volume history for one
    symbol by consuming Binance's raw @depth@100ms WebSocket stream. Runs
    forever in a daemon thread started at module import time."""

    def __init__(self, symbol: str = SYMBOL):
        self.symbol = symbol
        self._lock = threading.Lock()
        self._bids: dict[float, float] = {}
        self._asks: dict[float, float] = {}
        self._prev_depth_stats: dict[int, dict] = {}
        self.history: collections.deque = collections.deque(maxlen=MAX_DEPTH_HISTORY)
        self.update_count = 0
        self.crossover_count = 0
        self.max_price = 0.0
        self.min_price = float("inf")
        self.connected = False
        self._stop = False
        self._ws_app = None
        # Wall-clock moment this tracker object was constructed — i.e. this
        # server process's start time. Exposed to the UI so it can honestly
        # say "tracking since <this>" instead of implying unlimited history.
        self.started_at = int(time.time())
        # Rows waiting to go to SQLite, plus the second we last sampled. The
        # WS delivers ~10 msg/s; persisting every one would be 864k rows/day
        # for no extra information, so history is sampled at 1 Hz.
        self._pending: dict[int, dict] = {}
        self._last_sample_sec = 0
        self._restore_history()

    def _restore_history(self):
        """Repopulate the in-memory deque from disk so a restart doesn't
        throw away the accumulated order-book history."""
        try:
            with _db_lock, db_connect() as c:
                rows = c.execute(
                    "SELECT time, price, depths, crossovers FROM depth_history "
                    "WHERE symbol = ? ORDER BY time DESC LIMIT ?",
                    (self.symbol, MAX_DEPTH_HISTORY),
                ).fetchall()
            for t, price, depths, crossovers in reversed(rows):
                self.history.append({
                    "time": t,
                    "price": price,
                    "depths": {int(k): v for k, v in json.loads(depths).items()},
                    "crossovers": json.loads(crossovers),
                })
            if rows:
                self._last_sample_sec = rows[0][0]
                log.info("[depth] restored %d rows from disk (oldest %ds ago)",
                         len(rows), int(time.time()) - rows[-1][0])
        except Exception as e:
            log.warning("[depth] could not restore history: %s", e)

    def _flush_loop(self):
        while not self._stop:
            time.sleep(DEPTH_FLUSH_SECONDS)
            with self._lock:
                batch, self._pending = self._pending, {}
            if not batch:
                continue
            try:
                rows = [
                    (t, self.symbol, p["price"],
                     json.dumps(p["depths"]), json.dumps(p["crossovers"]))
                    for t, p in batch.items()
                ]
                with _db_lock, db_connect() as c:
                    c.executemany(
                        "INSERT OR REPLACE INTO depth_history "
                        "(time, symbol, price, depths, crossovers) VALUES (?,?,?,?,?)",
                        rows,
                    )
            except Exception as e:
                log.warning("[depth] flush failed (%d rows dropped): %s", len(batch), e)

    def start(self):
        threading.Thread(target=self._run_forever, name="depth-tracker", daemon=True).start()
        threading.Thread(target=self._flush_loop, name="depth-flush", daemon=True).start()
        return self

    def stop(self):
        self._stop = True
        if self._ws_app is not None:
            try:
                self._ws_app.close()
            except Exception:
                pass

    def _run_forever(self):
        while not self._stop:
            try:
                self._fetch_snapshot()
                self._stream()
            except Exception as e:
                log.warning("[depth] tracker error: %s", e)
            self.connected = False
            if self._stop:
                break
            time.sleep(DEPTH_RECONNECT_DELAY)

    def _fetch_snapshot(self):
        r = _session.get(
            FAPI_BASE + "/fapi/v1/depth",
            params={"symbol": self.symbol, "limit": 1000},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        with self._lock:
            self._bids = {float(p): float(q) for p, q in data["bids"]}
            self._asks = {float(p): float(q) for p, q in data["asks"]}

    def _stream(self):
        stream = f"{self.symbol.lower()}@depth@100ms"
        url = f"wss://fstream.binance.com/ws/{stream}"

        def on_open(wsapp):
            self.connected = True
            log.info("[depth] WS connected: %s", stream)

        def on_message(wsapp, message):
            try:
                self._handle_update(json.loads(message))
            except Exception as e:
                log.warning("[depth] parse error: %s", e)

        def on_error(wsapp, error):
            log.warning("[depth] WS error: %s", error)

        def on_close(wsapp, *_a):
            self.connected = False
            log.info("[depth] WS closed")

        self._ws_app = _wsclient.WebSocketApp(
            url, on_open=on_open, on_message=on_message,
            on_error=on_error, on_close=on_close,
        )
        self._ws_app.run_forever(ping_interval=60, ping_timeout=10)

    def _handle_update(self, data: dict):
        b, a = data.get("b"), data.get("a")
        if b is None or a is None:
            return

        with self._lock:
            for price_s, qty_s in b:
                price, qty = float(price_s), float(qty_s)
                if qty == 0:
                    self._bids.pop(price, None)
                else:
                    self._bids[price] = qty
            for price_s, qty_s in a:
                price, qty = float(price_s), float(qty_s)
                if qty == 0:
                    self._asks.pop(price, None)
                else:
                    self._asks[price] = qty

            sorted_bids = sorted(self._bids.items(), key=lambda kv: -kv[0])
            sorted_asks = sorted(self._asks.items(), key=lambda kv: kv[0])
            best_bid = sorted_bids[0][0] if sorted_bids else 0.0
            best_ask = sorted_asks[0][0] if sorted_asks else 0.0
            if best_bid <= 0 or best_ask <= 0:
                return
            price = (best_bid + best_ask) / 2.0

            self.update_count += 1
            if price > self.max_price:
                self.max_price = price
            if price < self.min_price:
                self.min_price = price

            d_stats = {}
            for depth in DEPTH_LEVELS:
                ratio = depth / 100.0
                bid_min = price * (1 - ratio)
                ask_max = price * (1 + ratio)
                bid_vol = sum(q for p, q in sorted_bids if p >= bid_min)
                ask_vol = sum(q for p, q in sorted_asks if p <= ask_max)
                d_stats[depth] = {"bidVolume": round(bid_vol, 6), "askVolume": round(ask_vol, 6)}

            crossovers = []
            for depth, stats in d_stats.items():
                prev = self._prev_depth_stats.get(depth)
                if prev:
                    cur_diff = stats["bidVolume"] - stats["askVolume"]
                    prev_diff = prev["bidVolume"] - prev["askVolume"]
                    if (prev_diff < 0 <= cur_diff) or (prev_diff > 0 >= cur_diff):
                        crossovers.append(depth)
            if crossovers:
                self.crossover_count += 1
            self._prev_depth_stats = d_stats

            ts = int(data.get("E", time.time() * 1000)) // 1000

            # Exactly one sample per wall-clock second. The stream delivers
            # ~10 msg/s, so without this the 86400-entry deque would cover
            # 2.4 hours rather than the day its size implies, and would not
            # line up with the 1 Hz series restored from disk.
            #
            # Updates inside a second are folded into the current sample
            # instead of appended: the row's primary key is (symbol, second),
            # so a second append would overwrite the first on disk and lose
            # whichever crossovers it carried.
            if ts == self._last_sample_sec and self.history:
                point = self.history[-1]
                point["price"] = round(price, 2)
                point["depths"] = d_stats
                if crossovers:
                    point["crossovers"] = sorted(set(point["crossovers"]) | set(crossovers))
            else:
                self._last_sample_sec = ts
                point = {
                    "time": ts,
                    "price": round(price, 2),
                    "depths": d_stats,
                    "crossovers": list(crossovers),
                }
                self.history.append(point)

            # Held by reference and serialised at flush time, so a second's
            # worth of updates costs one json.dumps instead of ten.
            self._pending[ts] = point

    def earliest_time(self) -> int | None:
        """Oldest timestamp still on disk for this symbol (14-day retention
        prunes anything older — see init_db). None if nothing persisted yet."""
        with _db_lock, db_connect() as c:
            row = c.execute(
                "SELECT MIN(time) FROM depth_history WHERE symbol = ?", (self.symbol,)
            ).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def _meta(self) -> dict:
        return {
            "symbol": self.symbol,
            "connected": self.connected,
            "updateCount": self.update_count,
            "crossoverCount": self.crossover_count,
            "maxPrice": self.max_price or None,
            "minPrice": self.min_price if self.min_price != float("inf") else None,
            "startedAt": self.started_at,
            "earliestSample": self.earliest_time(),
        }

    def snapshot(self, limit: int | None = None) -> dict:
        with self._lock:
            hist = list(self.history)
        if limit:
            hist = hist[-limit:]
        return {**self._meta(), "history": hist}

    def history_range(self, since_ts: int, until_ts: int | None = None,
                       bucket_seconds: int = 60) -> dict:
        """DB-backed range query, bypassing the in-memory deque's ~24h cap so
        the UI can scroll back through the full retention window. Rows are
        averaged into `bucket_seconds` buckets server-side — sending 14 days
        of raw 1Hz samples (~1.2M rows) to the browser would be pointless
        (nobody can see that resolution) and slow to transfer/render.
        """
        until_ts = until_ts or int(time.time())
        bucket_seconds = max(1, bucket_seconds)
        with _db_lock, db_connect() as c:
            rows = c.execute(
                "SELECT time, price, depths, crossovers FROM depth_history "
                "WHERE symbol = ? AND time >= ? AND time <= ? ORDER BY time ASC",
                (self.symbol, since_ts, until_ts),
            ).fetchall()

        buckets: dict[int, dict] = {}
        for t, price, depths_json, crossovers_json in rows:
            bt = (t // bucket_seconds) * bucket_seconds
            b = buckets.get(bt)
            if b is None:
                b = buckets[bt] = {"time": bt, "_price_sum": 0.0, "_n": 0,
                                    "_depth_sums": {}, "crossovers": set()}
            b["_price_sum"] += price
            b["_n"] += 1
            for depth_str, stats in json.loads(depths_json).items():
                depth = int(depth_str)
                ds = b["_depth_sums"].get(depth)
                if ds is None:
                    ds = b["_depth_sums"][depth] = {"bidVolume": 0.0, "askVolume": 0.0, "n": 0}
                ds["bidVolume"] += stats["bidVolume"]
                ds["askVolume"] += stats["askVolume"]
                ds["n"] += 1
            b["crossovers"].update(json.loads(crossovers_json))

        out = []
        for bt in sorted(buckets):
            b = buckets[bt]
            depths_avg = {
                depth: {
                    "bidVolume": round(ds["bidVolume"] / ds["n"], 6),
                    "askVolume": round(ds["askVolume"] / ds["n"], 6),
                }
                for depth, ds in b["_depth_sums"].items()
            }
            out.append({
                "time": bt,
                "price": round(b["_price_sum"] / b["_n"], 2),
                "depths": depths_avg,
                "crossovers": sorted(b["crossovers"]),
            })
        return {**self._meta(), "history": out, "bucketSeconds": bucket_seconds,
                "rangeStart": since_ts, "rangeEnd": until_ts}


_depth_tracker = DepthTracker(SYMBOL).start()


# ════════════════════════════════════════════════════════════════════
#  SMOOTHING HELPERS  (from AVSBOT f_smooth)
# ════════════════════════════════════════════════════════════════════

def _wma(series: pd.Series, n: int) -> pd.Series:
    w = np.arange(1, n + 1, dtype=float)
    return series.rolling(n).apply(lambda x: np.dot(x, w) / w.sum(), raw=True)


def _hma(series: pd.Series, length: int) -> pd.Series:
    half = max(length // 2, 1)
    sq   = max(int(math.sqrt(length)), 1)
    return _wma(2.0 * _wma(series, half) - _wma(series, length), sq)


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _sma(series: pd.Series, n: int) -> pd.Series:
    return series.rolling(n).mean()


def _rma(series: pd.Series, n: int) -> pd.Series:
    """Wilder's RMA (1/n alpha)"""
    return series.ewm(alpha=1.0 / n, adjust=False).mean()


# ════════════════════════════════════════════════════════════════════
#  WTMO — WaveTrend Momentum Oscillator
#  Exact copy of calculate_wavetrend() from AVSBOT indicator_worker.py
# ════════════════════════════════════════════════════════════════════

WT_N1         = 10
WT_N2         = 21
WT_SIGLEN     = 4
WT_SMOOTH_LEN = 9
WT_SMOOTH_TYPE = "HULL"


def calc_wtmo(df: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    src = (df["High"] + df["Low"] + df["Close"]) / 3.0

    esa = _ema(src, WT_N1)
    d   = _ema((src - esa).abs(), WT_N1)
    ci  = pd.Series(
        np.where(d != 0.0, (src - esa) / (0.015 * d), 0.0),
        index=df.index,
    )

    wt1_raw = _ema(ci, WT_N2)
    wt2_raw = _sma(wt1_raw, WT_SIGLEN)

    wt1 = _hma(wt1_raw, WT_SMOOTH_LEN)
    wt2 = _hma(wt2_raw, WT_SMOOTH_LEN)

    return wt1.round(3), wt2.round(3)


# ════════════════════════════════════════════════════════════════════
#  MLMI — Machine Learning Momentum Index (kNN)
#  Mirrors calculate_mlmi() + KNNStore from AVSBOT indicator_worker.py
# ════════════════════════════════════════════════════════════════════

MLMI_K      = 200
MLMI_WINDOW = 20
MLMI_MA_LEN = 20


def _rsi_fast(close: pd.Series, n: int) -> pd.Series:
    delta = close.diff()
    up    = delta.clip(lower=0.0)
    dn    = (-delta).clip(lower=0.0)
    return 100.0 - 100.0 / (1.0 + _rma(up, n) / _rma(dn, n).replace(0, np.nan))


def calc_mlmi(df: pd.DataFrame) -> tuple:
    close = df["Close"]
    n     = len(close)

    rsi5  = _rsi_fast(close, 5)
    rsi20 = _rsi_fast(close, 20)
    rq    = _wma(rsi5,  MLMI_WINDOW)
    rs    = _wma(rsi20, MLMI_WINDOW)
    mq    = _wma(close, 5)
    ms    = _wma(close, 20)

    cross = (
        ((mq > ms) & (mq.shift(1) <= ms.shift(1))) |
        ((mq < ms) & (mq.shift(1) >= ms.shift(1)))
    )

    pred = np.zeros(n, dtype=float)
    p1h: list[float] = []
    p2h: list[float] = []
    prh: list[float] = []
    reh: list[float] = []

    for i in range(n):
        rs_i = rs.iat[i]
        rq_i = rq.iat[i]
        if np.isnan(rs_i) or np.isnan(rq_i):
            continue
        if cross.iat[i]:
            if prh:
                reh[-1] = 1.0 if close.iat[i] >= prh[-1] else -1.0
            p1h.append(rs_i)
            p2h.append(rq_i)
            prh.append(float(close.iat[i]))
            reh.append(0.0)

        nc = len(p1h) - 1
        if nc >= 2:
            a1   = np.array(p1h[:nc], dtype=float)
            a2   = np.array(p2h[:nc], dtype=float)
            res  = np.array(reh[:nc],  dtype=float)
            dist = np.sqrt((rs_i - a1)**2 + (rq_i - a2)**2)
            k    = min(MLMI_K, len(dist))
            maxd = np.partition(dist, k - 1)[k - 1]
            pred[i] = res[dist <= maxd].sum()

    ps   = pd.Series(pred, index=df.index)
    pma  = _wma(ps, MLMI_MA_LEN)

    ch   = min(500, n)
    up   = ps.rolling(ch).max()
    lo   = ps.rolling(ch).min()
    sd   = ps.rolling(20).std()
    dema = _ema(sd, 20)

    return ps.round(3), pma.round(3), up.round(3), lo.round(3), \
           (up - dema).round(3), (lo + dema).round(3)


# ════════════════════════════════════════════════════════════════════
#  STANDARD INDICATORS  (pure numpy/pandas — mirrors AVSBOT helpers)
# ════════════════════════════════════════════════════════════════════

def calc_rsi(close: pd.Series, n: int = 14) -> pd.Series:
    """Mirrors compute_rsi() from AVSBOT (ewm com=n-1 variant)"""
    d  = close.diff()
    up = d.clip(lower=0.0)
    dn = (-d).clip(lower=0.0)
    eu = up.ewm(com=n - 1, adjust=False).mean()
    ed = dn.ewm(com=n - 1, adjust=False).mean()
    return (100.0 - 100.0 / (1.0 + eu / ed.replace(0, np.nan))).round(3)


def calc_mfi(df: pd.DataFrame, n: int = 14) -> pd.Series:
    """Mirrors compute_mfi() from AVSBOT"""
    tp  = (df["High"] + df["Low"] + df["Close"]) / 3.0
    mf  = tp * df["Volume"]
    pos = mf.where(tp > tp.shift(1), 0.0).rolling(n).sum()
    neg = mf.where(tp < tp.shift(1), 0.0).rolling(n).sum()
    return (100.0 - 100.0 / (1.0 + pos / neg.replace(0, np.nan))).round(3)


def calc_cci(df: pd.DataFrame, n: int = 20) -> pd.Series:
    """Mirrors compute_cci() from AVSBOT"""
    tp = (df["High"] + df["Low"] + df["Close"]) / 3.0
    ma = tp.rolling(n).mean()
    md = tp.rolling(n).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return ((tp - ma) / (0.015 * md.replace(0, np.nan))).round(3)


def calc_willr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    hh  = df["High"].rolling(n).max()
    ll  = df["Low"].rolling(n).min()
    rng = (hh - ll).replace(0, np.nan)
    return (((hh - df["Close"]) / rng) * -100.0).round(3)


def calc_uo(df: pd.DataFrame) -> pd.Series:
    """Mirrors compute_uo() from AVSBOT"""
    h, l, c = df["High"], df["Low"], df["Close"]
    pc  = c.shift(1)
    bp  = c - pd.concat([l, pc], axis=1).min(axis=1)
    tr  = pd.concat([h, pc], axis=1).max(axis=1) - pd.concat([l, pc], axis=1).min(axis=1)
    a7  = bp.rolling(7).sum() / tr.rolling(7).sum().replace(0, np.nan)
    a14 = bp.rolling(14).sum() / tr.rolling(14).sum().replace(0, np.nan)
    a28 = bp.rolling(28).sum() / tr.rolling(28).sum().replace(0, np.nan)
    return (100.0 * (4*a7 + 2*a14 + a28) / 7.0).round(3)


def calc_cmf(df: pd.DataFrame, n: int = 20) -> pd.Series:
    """Mirrors compute_cmf() from AVSBOT"""
    h, l, c, v = df["High"], df["Low"], df["Close"], df["Volume"]
    mfv = ((c - l) - (h - c)) / (h - l).replace(0, np.nan) * v
    return (mfv.rolling(n).sum() / v.rolling(n).sum().replace(0, np.nan)).round(4)


def calc_vwap(df: pd.DataFrame, n: int = 24) -> tuple:
    """Rolling VWAP + +-1sigma/+-2sigma bands. Mirrors the rolling-window
    approach in chart_vwap.py (session-relative, not anchored-to-open)."""
    tp  = (df["High"] + df["Low"] + df["Close"]) / 3.0
    vol = df["Volume"]
    vwap = (tp * vol).rolling(n).sum() / vol.rolling(n).sum().replace(0, np.nan)
    std  = np.sqrt(((tp - vwap) ** 2).rolling(n).mean())
    return vwap, vwap + std, vwap - std, vwap + 2 * std, vwap - 2 * std


def calc_cvd(df: pd.DataFrame) -> pd.Series:
    """Cumulative volume delta: running sum of (2*taker_buy - volume) across
    the returned window. Mirrors the delta_raw/cum_delta calc in chart_vwap.py."""
    delta = 2.0 * df["TakerBuyBase"] - df["Volume"]
    return delta.cumsum()


def calc_adx(df: pd.DataFrame, n: int = 14) -> tuple:
    """Mirrors compute_adx() from AVSBOT"""
    h, l, c = df["High"], df["Low"], df["Close"]
    up   = h.diff()
    down = -l.diff()
    pdm  = np.where((up > down) & (up > 0), up, 0.0)
    ndm  = np.where((down > up) & (down > 0), down, 0.0)
    tr1  = h - l
    tr2  = (h - c.shift(1)).abs()
    tr3  = (l - c.shift(1)).abs()
    tr   = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)

    atr  = tr.ewm(com=n-1, adjust=False).mean()
    pdi  = 100.0 * pd.Series(pdm, index=df.index).ewm(com=n-1, adjust=False).mean() / atr.replace(0, np.nan)
    ndi  = 100.0 * pd.Series(ndm, index=df.index).ewm(com=n-1, adjust=False).mean() / atr.replace(0, np.nan)
    dx   = 100.0 * (pdi - ndi).abs() / (pdi + ndi).replace(0, np.nan)
    adx  = dx.ewm(com=n-1, adjust=False).mean()
    return adx.round(3), pdi.round(3), ndi.round(3)


# ════════════════════════════════════════════════════════════════════
#  GOLD PAGE INDICATORS  (LRC · MA Cross · Parabolic SAR · Linear Regression Slope)
#  UO reuses calc_uo() above — same fixed 7/14/28 periods.
# ════════════════════════════════════════════════════════════════════

def calc_lrc(df: pd.DataFrame, length: int = 84, mult: float = 2.0) -> tuple:
    """Linear Regression Channel: basis = least-squares fit endpoint over
    the trailing window, bands = +-mult * stdev of the fit's residuals."""
    close = df["Close"].to_numpy(dtype=float)
    n = len(close)
    mid   = np.full(n, np.nan)
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    if n >= length:
        x = np.arange(length, dtype=float)
        x_mean = x.mean()
        x_var  = ((x - x_mean) ** 2).sum()
        for i in range(length - 1, n):
            y = close[i - length + 1:i + 1]
            y_mean = y.mean()
            slope  = ((x - x_mean) * (y - y_mean)).sum() / x_var
            intercept = y_mean - slope * x_mean
            fitted_end = intercept + slope * x[-1]
            resid  = y - (intercept + slope * x)
            stdev  = resid.std(ddof=0)
            mid[i]   = fitted_end
            upper[i] = fitted_end + mult * stdev
            lower[i] = fitted_end - mult * stdev
    idx = df.index
    return pd.Series(mid, index=idx), pd.Series(upper, index=idx), pd.Series(lower, index=idx)


def calc_ma_cross(df: pd.DataFrame, fast: int = 9, slow: int = 26) -> tuple:
    ma_fast = df["Close"].rolling(fast).mean()
    ma_slow = df["Close"].rolling(slow).mean()
    return ma_fast, ma_slow


def calc_psar(df: pd.DataFrame, start: float = 0.02, incr: float = 0.02, max_af: float = 0.2) -> pd.Series:
    """Wilder's Parabolic SAR — mirrors Pine's built-in sar(start, incr, max)."""
    high  = df["High"].to_numpy(dtype=float)
    low   = df["Low"].to_numpy(dtype=float)
    n = len(high)
    sar = np.full(n, np.nan)
    if n == 0:
        return pd.Series(sar, index=df.index)

    trend_up = True
    af  = start
    ep  = high[0]
    val = low[0]
    sar[0] = val

    for i in range(1, n):
        val = val + af * (ep - val)
        if trend_up:
            val = min(val, low[i - 1], low[i - 2] if i >= 2 else low[i - 1])
            if low[i] < val:
                trend_up, val, ep, af = False, ep, low[i], start
            elif high[i] > ep:
                ep = high[i]
                af = min(af + incr, max_af)
        else:
            val = max(val, high[i - 1], high[i - 2] if i >= 2 else high[i - 1])
            if high[i] > val:
                trend_up, val, ep, af = True, ep, high[i], start
            elif low[i] < ep:
                ep = low[i]
                af = min(af + incr, max_af)
        sar[i] = val

    return pd.Series(sar, index=df.index)


def calc_linreg_slope(df: pd.DataFrame, length: int = 7) -> pd.Series:
    """Least-squares slope of Close over the trailing window (price/bar)."""
    close = df["Close"].to_numpy(dtype=float)
    n = len(close)
    slope = np.full(n, np.nan)
    if n >= length:
        x = np.arange(length, dtype=float)
        x_mean = x.mean()
        x_var  = ((x - x_mean) ** 2).sum()
        for i in range(length - 1, n):
            y = close[i - length + 1:i + 1]
            slope[i] = ((x - x_mean) * (y - y.mean())).sum() / x_var
    return pd.Series(slope, index=df.index)


def calc_gold_indicators(df: pd.DataFrame) -> dict:
    out = {}

    def safe(key, fn):
        try:
            out[key] = _ser(fn())
        except Exception as e:
            log.error("[gold:%s] %s", key, e)
            out[key] = [None] * len(df)

    try:
        mid, upper, lower = calc_lrc(df, 84, 2.0)
        out["lrc_mid"]   = _ser(mid)
        out["lrc_upper"] = _ser(upper)
        out["lrc_lower"] = _ser(lower)
    except Exception as e:
        log.error("[gold:lrc] %s", e)
        out["lrc_mid"] = out["lrc_upper"] = out["lrc_lower"] = [None] * len(df)

    try:
        ma_fast, ma_slow = calc_ma_cross(df, 9, 26)
        out["ma_fast"] = _ser(ma_fast)
        out["ma_slow"] = _ser(ma_slow)
    except Exception as e:
        log.error("[gold:ma_cross] %s", e)
        out["ma_fast"] = out["ma_slow"] = [None] * len(df)

    safe("sar",          lambda: calc_psar(df, 0.02, 0.02, 0.2))
    safe("uo",            lambda: calc_uo(df))
    safe("linreg_slope", lambda: calc_linreg_slope(df, 7))

    return out


# ════════════════════════════════════════════════════════════════════
#  AGGREGATE
# ════════════════════════════════════════════════════════════════════

def _ser(s: pd.Series) -> list:
    return [
        None if (v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))))
        else round(float(v), 3)
        for v in s
    ]


def calc_all(df: pd.DataFrame) -> dict:
    out = {}

    def safe(key, fn):
        try:
            out[key] = _ser(fn())
        except Exception as e:
            log.error("[%s] %s", key, e)
            out[key] = [None] * len(df)

    safe("rsi",   lambda: calc_rsi(df["Close"]))
    safe("mfi",   lambda: calc_mfi(df))
    safe("cci",   lambda: calc_cci(df))
    safe("willr", lambda: calc_willr(df))
    safe("uo",    lambda: calc_uo(df))
    safe("cmf",   lambda: calc_cmf(df))

    try:
        adx, dip, dim = calc_adx(df)
        out["adx"] = _ser(adx)
        out["dmp"] = _ser(dip)
        out["dmm"] = _ser(dim)
    except Exception as e:
        log.error("[adx] %s", e)
        out["adx"] = out["dmp"] = out["dmm"] = [None] * len(df)

    try:
        wt1, wt2 = calc_wtmo(df)
        out["wt1"] = _ser(wt1)
        out["wt2"] = _ser(wt2)
    except Exception as e:
        log.error("[wtmo] %s", e)
        out["wt1"] = out["wt2"] = [None] * len(df)

    try:
        ps, pma, up, lo, up_, lo_ = calc_mlmi(df)
        out["mlmi"]    = _ser(ps)
        out["mlmi_ma"] = _ser(pma)
        out["mlmi_up"] = _ser(up)
        out["mlmi_lo"] = _ser(lo)
        out["mlmi_u_"] = _ser(up_)
        out["mlmi_l_"] = _ser(lo_)
    except Exception as e:
        log.error("[mlmi] %s", e)
        for k in ["mlmi", "mlmi_ma", "mlmi_up", "mlmi_lo", "mlmi_u_", "mlmi_l_"]:
            out[k] = [None] * len(df)

    try:
        vwap, vu1, vd1, vu2, vd2 = calc_vwap(df)
        out["vwap"]    = _ser(vwap)
        out["vwap_u1"] = _ser(vu1)
        out["vwap_d1"] = _ser(vd1)
        out["vwap_u2"] = _ser(vu2)
        out["vwap_d2"] = _ser(vd2)
    except Exception as e:
        log.error("[vwap] %s", e)
        for k in ["vwap", "vwap_u1", "vwap_d1", "vwap_u2", "vwap_d2"]:
            out[k] = [None] * len(df)

    safe("cvd", lambda: calc_cvd(df))

    return out


# ════════════════════════════════════════════════════════════════════
#  FLASK ROUTES
# ════════════════════════════════════════════════════════════════════

@app.get("/api/data/<tf>")
def data(tf: str):
    if tf not in TF_INTERVAL:
        return jsonify(error=f"Unknown timeframe: {tf}"), 400
    symbol = resolve_symbol()
    try:
        interval, limit = TF_INTERVAL[tf]
        df = get_klines(symbol, interval, limit)
        if df.empty:
            return jsonify(error="No data from Binance Futures"), 503

        ind   = calc_all(df)
        ohlcv = [
            {
                "time":      int(row["time"]),
                "open":      float(row["Open"]),
                "high":      float(row["High"]),
                "low":       float(row["Low"]),
                "close":     float(row["Close"]),
                "volume":    float(row["Volume"]),
                "taker_buy": float(row.get("TakerBuyBase", 0.0)),
            }
            for _, row in df.iterrows()
        ]
        return jsonify(
            timeframe  = tf,
            instrument = symbol,
            source     = "Binance Futures",
            ohlcv      = ohlcv,
            indicators = ind,
            ts         = int(time.time()),
        )
    except requests.RequestException as e:
        log.error("Binance error: %s", e)
        return jsonify(error=str(e)), 503
    except Exception as e:
        log.exception("Unexpected error")
        return jsonify(error=str(e)), 500


@app.get("/api/gold/<tf>")
def gold_data(tf: str):
    if tf not in GOLD_TF_INTERVAL:
        return jsonify(error=f"Unknown timeframe: {tf}"), 400
    try:
        interval, limit = GOLD_TF_INTERVAL[tf]
        df = get_klines(GOLD_SYMBOL, interval, limit)
        if df.empty:
            return jsonify(error="No data from Binance Futures"), 503

        ind   = calc_gold_indicators(df)
        ohlcv = [
            {
                "time":  int(row["time"]),
                "open":  float(row["Open"]),
                "high":  float(row["High"]),
                "low":   float(row["Low"]),
                "close": float(row["Close"]),
                "volume": float(row["Volume"]),
            }
            for _, row in df.iterrows()
        ]
        return jsonify(
            timeframe  = tf,
            instrument = GOLD_SYMBOL,
            source     = "Binance Futures (PAXG/USDT proxy)",
            ohlcv      = ohlcv,
            indicators = ind,
            ts         = int(time.time()),
        )
    except requests.RequestException as e:
        log.error("Binance error: %s", e)
        return jsonify(error=str(e)), 503
    except Exception as e:
        log.exception("Unexpected error")
        return jsonify(error=str(e)), 500


# ════════════════════════════════════════════════════════════════════
#  ORDER BOOK DEPTH  (backend-tracked — see DepthTracker above)
# ════════════════════════════════════════════════════════════════════

@app.get("/api/depth/history")
def depth_history():
    since = request.args.get("since", type=int)
    if since is not None:
        until  = request.args.get("until", type=int)
        bucket = request.args.get("bucket", default=60, type=int)
        return jsonify(_depth_tracker.history_range(since, until, bucket_seconds=bucket))
    limit = request.args.get("limit", type=int)
    return jsonify(_depth_tracker.snapshot(limit=limit))


# ════════════════════════════════════════════════════════════════════
#  COINGLASS LIQUIDATION HEATMAP  (best-effort — see coinglass_analyzer.py
#  header: this scrapes CoinGlass's private encrypted API with a session
#  token that must be refreshed from browser DevTools every few days.
#  Cached briefly since each successful call is slow and rate-limited.)
# ════════════════════════════════════════════════════════════════════

_cg_heatmap_cache: dict = {}  # symbol -> {"data": [...] | None, "ts": float}
CG_HEATMAP_TTL = 300  # 5 minutes


def _parse_liq_heatmap(raw: dict) -> list[dict] | None:
    """Adapts liqHeatMap's current response shape — {prices: [[time_s, o,h,l,c,v], ...],
    y: [price, ...], liq: [[time_idx, price_idx, volume], ...]} — into flat
    {price, timestamp, volume} records.

    coinglass_analyzer.parse_heatmap() expects an older x/y/dataMap shape that
    this endpoint no longer returns (confirmed live: current payload has
    prices/y/liq index-triples instead). Adapting here rather than editing
    that already-fragile, reverse-engineered file. Falls back to
    parse_heatmap() in case CoinGlass reverts or another caller hits a
    variant that still matches it.
    """
    prices, y, liq = raw.get("prices"), raw.get("y"), raw.get("liq")
    if not prices or not y or not liq:
        return None
    records = []
    for time_idx, price_idx, vol in liq:
        if vol and vol > 0 and 0 <= time_idx < len(prices) and 0 <= price_idx < len(y):
            records.append({"price": y[price_idx], "timestamp": prices[time_idx][0], "volume": vol})
    return records or None


@app.get("/api/liquidations/heatmap")
def liquidations_heatmap():
    symbol = (request.args.get("symbol") or "BTCUSDT").upper()
    if not re.fullmatch(r"[A-Z0-9]{2,20}", symbol):
        return jsonify(ok=False, source="CoinGlass", error=f"bad symbol {symbol!r}"), 400

    now = time.time()
    cached = _cg_heatmap_cache.setdefault(symbol, {"data": None, "ts": 0.0})
    if cached["data"] is not None and now - cached["ts"] < CG_HEATMAP_TTL:
        return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=False,
                       fetchedAt=int(cached["ts"]), records=cached["data"])

    try:
        cg = get_coinglass()
        raw = cg.fetch_liq_heatmap_binance(symbol=f"Binance_{symbol}", interval=5, limit=288)
        if raw is None:
            # fetch_* returns None on 401 (expired session token), 403, or a
            # decode failure — all of which mean "stale credentials", not
            # "no data right now". Surface that distinction to the UI instead
            # of quietly showing an empty chart.
            if cached["data"] is not None:
                return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=True,
                               fetchedAt=int(cached["ts"]), records=cached["data"],
                               warning="CoinGlass session token likely expired — showing last known data. "
                                       "Refresh COINGLASS_OBE from browser DevTools (see coinglass_analyzer.py).")
            return jsonify(ok=False, source="CoinGlass",
                           error="CoinGlass request failed or session token expired. "
                                 "Refresh COINGLASS_OBE from browser DevTools (see coinglass_analyzer.py)."), 502

        records = _parse_liq_heatmap(raw) or cg.parse_heatmap(raw)
        if not records:
            return jsonify(ok=False, source="CoinGlass",
                           error="CoinGlass returned no parseable heatmap data"), 502

        cached.update(data=records, ts=now)
        return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=False,
                       fetchedAt=int(now), records=records)
    except FileNotFoundError as e:
        return jsonify(ok=False, source="CoinGlass", error=str(e)), 500
    except Exception as e:
        log.exception("CoinGlass heatmap route error")
        return jsonify(ok=False, source="CoinGlass", error=str(e)), 500


# ════════════════════════════════════════════════════════════════════
#  COINGLASS LIQUIDATION MAP  (exLiqMap — price-indexed, NOT time-indexed:
#  every liquidation level currently standing across the visible range,
#  summed across Binance/OKX/Bybit. Same auth/caching story as the heatmap
#  above — see coinglass_analyzer.py header.)
# ════════════════════════════════════════════════════════════════════

_cg_liqmap_cache: dict = {}  # symbol -> {"data": {...} | None, "ts": float}
CG_LIQMAP_TTL = 300  # 5 minutes


def _parse_liq_map_exchange(raw: dict) -> dict | None:
    """exLiqMap's shape (confirmed live):
        {rangeHigh, rangeLow, lastPrice,
         data: [{instrument: {exName}, liqMapV2: {"<price>": [[price, usd, null, null], ...]}}, ...]}
    — one entry in `data` per exchange (Binance/OKX/Bybit, since we request
    merge=true). Summed across exchanges into a single price -> USD map, the
    same way CoinGlass's own chart stacks them into one bar per price level.
    `side` follows this app's existing convention (heatSnapshot/liqProfile in
    zones.js): BUY = price at/above lastPrice = short liquidations, SELL =
    below = long liquidations.
    """
    if not raw or not isinstance(raw.get("data"), list):
        return None
    last_price = raw.get("lastPrice")
    if not last_price:
        return None

    merged: dict[float, float] = {}
    for ex in raw["data"]:
        for entries in (ex.get("liqMapV2") or {}).values():
            for entry in entries or []:
                if not entry or len(entry) < 2 or entry[0] is None or entry[1] is None:
                    continue
                price, usd = float(entry[0]), float(entry[1])
                merged[price] = merged.get(price, 0.0) + usd
    if not merged:
        return None

    levels = [
        {"price": p, "usd": usd, "qty": usd / p, "side": "BUY" if p >= last_price else "SELL"}
        for p, usd in sorted(merged.items())
    ]
    return {"levels": levels, "lastPrice": last_price,
            "rangeHigh": raw.get("rangeHigh"), "rangeLow": raw.get("rangeLow")}


@app.get("/api/liquidations/map")
def liquidations_map():
    symbol = (request.args.get("symbol") or "BTCUSDT").upper()
    if not re.fullmatch(r"[A-Z0-9]{2,20}", symbol):
        return jsonify(ok=False, source="CoinGlass", error=f"bad symbol {symbol!r}"), 400
    base = symbol[:-4] if symbol.endswith("USDT") else symbol

    now = time.time()
    cached = _cg_liqmap_cache.setdefault(symbol, {"data": None, "ts": 0.0})
    if cached["data"] is not None and now - cached["ts"] < CG_LIQMAP_TTL:
        return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=False,
                       fetchedAt=int(cached["ts"]), **cached["data"])

    try:
        cg = get_coinglass()
        raw = cg.fetch_liq_map_exchange(symbol=base, interval=5, limit=2000)
        if raw is None:
            if cached["data"] is not None:
                return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=True,
                               fetchedAt=int(cached["ts"]), **cached["data"],
                               warning="CoinGlass session token likely expired — showing last known data. "
                                       "Refresh COINGLASS_OBE from browser DevTools (see coinglass_analyzer.py).")
            return jsonify(ok=False, source="CoinGlass",
                           error="CoinGlass request failed or session token expired. "
                                 "Refresh COINGLASS_OBE from browser DevTools (see coinglass_analyzer.py)."), 502

        parsed = _parse_liq_map_exchange(raw)
        if not parsed:
            return jsonify(ok=False, source="CoinGlass",
                           error="CoinGlass returned no parseable liquidation-map data"), 502

        cached.update(data=parsed, ts=now)
        return jsonify(ok=True, source="CoinGlass", symbol=symbol, stale=False,
                       fetchedAt=int(now), **parsed)
    except FileNotFoundError as e:
        return jsonify(ok=False, source="CoinGlass", error=str(e)), 500
    except Exception as e:
        log.exception("CoinGlass liquidation-map route error")
        return jsonify(ok=False, source="CoinGlass", error=str(e)), 500


# ════════════════════════════════════════════════════════════════════
#  MACRO CALENDAR + TELEGRAM NOTIFICATIONS
# ════════════════════════════════════════════════════════════════════

import macro as _macro_mod
import telegram_notify as _tg_mod

_macro = _macro_mod.MacroCalendar(
    db_connect, _db_lock, os.path.join(GRAPH_DIR, "macro_meta.json")).start()


def _data_payload(tf: str) -> dict:
    """The same shape /api/data/<tf> returns, without going through HTTP —
    used by the notifier to build its picture."""
    interval, limit = TF_INTERVAL[tf]
    df = get_klines(SYMBOL, interval, limit)
    if df.empty:
        return {}
    return {
        "timeframe": tf,
        "instrument": SYMBOL,
        "indicators": calc_all(df),
        "ohlcv": [
            {"time": int(r["time"]), "open": float(r["Open"]), "high": float(r["High"]),
             "low": float(r["Low"]), "close": float(r["Close"]),
             "volume": float(r["Volume"]), "taker_buy": float(r.get("TakerBuyBase", 0.0))}
            for _, r in df.iterrows()
        ],
    }


_telegram = _tg_mod.TelegramNotifier(
    os.path.join(GRAPH_DIR, "telegram_config.json"), _data_payload, macro=_macro).start()


@app.get("/api/macro/events")
def macro_events():
    """Events for today .. today+days-1 in the *caller's* timezone.

    tz is passed straight through in the browser's own getTimezoneOffset()
    sign convention — MacroCalendar.window() does the UTC-to-local
    conversion itself. (This route used to negate it AGAIN on top of that,
    which canceled out window()'s own correction and put viewers back to
    square one — a wrong local "today" by up to 2x their own offset.)
    """
    max_days = _macro_mod.LOOKBACK_DAYS + _macro_mod.LOOKAHEAD_DAYS + 1
    days = min(max(request.args.get("days", default=2, type=int), 1), max_days)
    tz = request.args.get("tz", default=0, type=int)
    offset = min(max(request.args.get("offset", default=0, type=int),
                      -_macro_mod.LOOKBACK_DAYS), _macro_mod.LOOKAHEAD_DAYS - days + 1)
    return jsonify(
        events=_macro.window(tz_offset_minutes=tz, days=days, start_offset=offset),
        status=_macro.status(),
    )


@app.get("/api/macro/status")
def macro_status():
    return jsonify(_macro.status())


@app.post("/api/macro/refresh")
def macro_refresh():
    ok = _macro.refresh()
    return jsonify(ok=ok, status=_macro.status()), (200 if ok else 503)


@app.get("/api/telegram/config")
def telegram_get_config():
    cfg = _telegram.public_config()
    cfg["status"] = _telegram.status()
    return jsonify(cfg)


@app.post("/api/telegram/config")
def telegram_set_config():
    patch = request.get_json(silent=True) or {}
    return jsonify(_telegram.update(patch))


@app.post("/api/telegram/detect-chat")
def telegram_detect_chat():
    """Resolve the human's chat id from getUpdates.

    The number before the colon in a bot token is the bot's own id; sending
    to it fails. The real chat id only becomes visible after the user has
    messaged the bot at least once.
    """
    try:
        return jsonify(ok=True, **_telegram.detect_chat_id())
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


@app.post("/api/telegram/volume-live")
def telegram_volume_live():
    """Poked by the browser the instant a forming bar's colour crosses a
    signal threshold — the client-side counterpart to _check_volume's
    closed-bar loop. `tf` must match the configured alert interval or this
    is a harmless no-op (see check_live_volume)."""
    body = request.get_json(silent=True) or {}
    tf = body.get("tf", "")
    try:
        return jsonify(_telegram.check_live_volume(tf))
    except Exception as e:
        return jsonify(marked=False, error=str(e)), 400


@app.post("/api/telegram/test")
def telegram_test():
    """Send a test message.

    Reports `enabled` back so the UI cannot show a green "delivered" while the
    notifier loop is switched off — a passing test with alerts disabled is
    exactly the "no signal vs no data" confusion this dashboard is meant to
    avoid.
    """
    try:
        me = _telegram.get_me()
        on = bool(_telegram.config.get("enabled"))
        body = ("✅ <b>CryptoDATEX connected</b>\n"
                "<code>Volume-spike and macro alerts will arrive here.</code>")
        if not on:
            body += ("\n\n⚠️ <b>Notifications are switched OFF</b>\n"
                     "<code>This test was sent directly. Tick "
                     "\"Уведомления включены\" and save, or nothing else "
                     "will be delivered.</code>")
        _telegram.send_message(body)
        return jsonify(ok=True, bot=me.get("username"), enabled=on)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 400


# ════════════════════════════════════════════════════════════════════
#  TOP-10 CORRELATION
# ════════════════════════════════════════════════════════════════════

CORR_COINS = [
    'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
    'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT', 'LTCUSDT',
    'MATICUSDT', 'UNIUSDT', 'ATOMUSDT', 'NEARUSDT', 'APTUSDT',
    'ARBUSDT', 'OPUSDT', 'FILUSDT', 'BCHUSDT', 'ETCUSDT',
    'XLMUSDT', 'VETUSDT', 'ICPUSDT', 'ALGOUSDT', 'SUIUSDT',
    'LDOUSDT', 'INJUSDT', 'FETUSDT', 'RENDERUSDT', 'WIFUSDT',
]
_corr_cache: dict = {'data': None, 'ts': 0.0}
CORR_TTL = 300  # 5 minutes

# Whitelist of switchable symbols (BTC + the correlation basket). Prevents
# arbitrary symbols from being forwarded to Binance / CoinGlass.
ALLOWED_SYMBOLS = {SYMBOL, *CORR_COINS}


def resolve_symbol(default: str = SYMBOL) -> str:
    """Read ?symbol= from the request, validated against ALLOWED_SYMBOLS."""
    s = (request.args.get("symbol") or default).upper()
    return s if s in ALLOWED_SYMBOLS else default


def _pearson(a, b):
    try:
        n = min(len(a), len(b))
        if n < 5:
            return 0.0
        r = float(np.corrcoef(a[-n:], b[-n:])[0, 1])
        return 0.0 if (math.isnan(r) or math.isinf(r)) else r
    except Exception:
        return 0.0


def _fetch_coin_corr(sym: str, btc_ret) -> dict | None:
    try:
        df = get_klines(sym, '1h', 101)
        if df.empty or len(df) < 26:
            return None
        closes = df['Close'].values.astype(float)
        n = min(len(btc_ret), len(closes) - 1)
        if n < 10:
            return None
        denom     = np.where(closes[-n-1:-1] != 0, closes[-n-1:-1], 1.0)
        coin_ret  = np.diff(closes[-n-1:]) / denom
        corr      = _pearson(btc_ret, coin_ret)
        change24  = float((closes[-1] / closes[-25] - 1) * 100) if len(closes) > 25 else 0.0
        return {
            'symbol':     sym.replace('USDT', ''),
            'full_symbol':sym,
            'correlation':round(float(corr), 4),
            'change_24h': round(change24, 2),
            'price':      round(float(closes[-1]), 4),
        }
    except Exception as e:
        log.warning('Corr error %s: %s', sym, e)
        return None


@app.get('/api/correlations')
def correlations():
    now = time.time()
    if _corr_cache['data'] and now - _corr_cache['ts'] < CORR_TTL:
        return jsonify(_corr_cache['data'])

    btc_df = get_klines(SYMBOL, '1h', 101)
    if btc_df.empty:
        return jsonify(error='BTC data unavailable'), 503

    btc_c  = btc_df['Close'].values.astype(float)
    denom  = np.where(btc_c[:-1] != 0, btc_c[:-1], 1.0)
    btc_ret = np.diff(btc_c) / denom

    results = []
    with ThreadPoolExecutor(max_workers=10) as ex:
        futures = {ex.submit(_fetch_coin_corr, sym, btc_ret): sym for sym in CORR_COINS}
        for fut in as_completed(futures):
            r = fut.result()
            if r:
                results.append(r)

    results.sort(key=lambda x: x['correlation'], reverse=True)

    # BTC itself — perfectly correlated, always the first/default row.
    btc_change = round(float((btc_c[-1] / btc_c[-25] - 1) * 100), 2) if len(btc_c) > 25 else 0.0
    btc_row = {
        'symbol':      'BTC',
        'full_symbol': SYMBOL,
        'correlation': 1.0,
        'change_24h':  btc_change,
        'price':       round(float(btc_c[-1]), 2),
    }
    payload = {
        'top10':   [btc_row] + results[:10],
        'all':     [btc_row] + results,
        'ts':      int(now),
        'ttl':     CORR_TTL,
        'btc_price': round(float(btc_c[-1]), 2),
    }
    _corr_cache['data'] = payload
    _corr_cache['ts']   = now
    return jsonify(payload)


# ════════════════════════════════════════════════════════════════════
#  LIQUIDATIONS  — Binance Futures Live WebSocket Collector
# ════════════════════════════════════════════════════════════════════

import threading
from collections import deque

_liq_buffer = deque(maxlen=2000)
_liq_lock = threading.Lock()

def _start_binance_liq_ws():
    """Background thread listening to Binance Futures forceOrders WebSocket."""
    import websocket
    def on_message(ws, message):
        try:
            msg = json.loads(message)
            o = msg.get('o') or msg
            if not o or 's' not in o:
                return
            sym     = o.get('s', '')
            side    = o.get('S', '')
            price_f = float(o.get('p') or o.get('ap') or 0)
            qty     = float(o.get('q', 0))
            usd_val = price_f * qty
            ts_ms   = int(o.get('T', int(time.time() * 1000)))

            item = {
                'time':    ts_ms // 1000,
                'ts_ms':   ts_ms,
                'side':    side,
                'price':   round(price_f, 2),
                'qty':     round(qty, 4),
                'usd':     round(usd_val, 0),
                'symbol':  sym,
            }
            with _liq_lock:
                _liq_buffer.appendleft(item)
        except Exception:
            pass

    def on_error(ws, error):
        log.warning("[Liq WS Thread] Error: %s", error)

    def on_close(ws, close_status_code, close_msg):
        log.info("[Liq WS Thread] Closed, reconnecting in 3s...")
        time.sleep(3)
        _run()

    def _run():
        try:
            ws = websocket.WebSocketApp(
                "wss://fstream.binance.com/ws/!forceOrder@arr",
                on_message=on_message,
                on_error=on_error,
                on_close=on_close,
            )
            ws.run_forever()
        except Exception as e:
            log.warning("[Liq WS Thread] Exception: %s", e)
            time.sleep(5)
            _run()

    t = threading.Thread(target=_run, daemon=True, name="BinanceLiqWS")
    t.start()
    log.info("  Started Binance Liquidations background WS listener")

# Start WS background collector
try:
    _start_binance_liq_ws()
except Exception as _e:
    log.warning("Could not start WS liquidation collector: %s", _e)


@app.get('/api/liquidations')
def liquidations():
    """
    Return accumulated live liquidations from background WebSocket collector.
    """
    now = time.time()
    sym = request.args.get('symbol', SYMBOL).upper()

    with _liq_lock:
        raw_items = list(_liq_buffer)

    # Filter items for requested symbol
    items = [it for it in raw_items if it['symbol'] == sym]

    long_total  = sum(it['usd'] for it in items if it['side'] == 'SELL')
    short_total = sum(it['usd'] for it in items if it['side'] == 'BUY')
    long_count  = sum(1 for it in items if it['side'] == 'SELL')
    short_count = sum(1 for it in items if it['side'] == 'BUY')

    # Hourly buckets
    buckets: dict[int, dict] = {}
    for it in items:
        bk = (it['ts_ms'] // 3_600_000) * 3_600_000
        if bk not in buckets:
            buckets[bk] = {'ts_ms': bk, 'long_usd': 0, 'short_usd': 0,
                           'long_count': 0, 'short_count': 0}
        if it['side'] == 'SELL':
            buckets[bk]['long_usd']    += it['usd']; buckets[bk]['long_count']  += 1
        else:
            buckets[bk]['short_usd']   += it['usd']; buckets[bk]['short_count'] += 1

    top10 = sorted(items, key=lambda x: x['usd'], reverse=True)[:10]

    payload = {
        'symbol':      sym,
        'count':       len(items),
        'long_total':  round(long_total, 0),
        'short_total': round(short_total, 0),
        'long_count':  long_count,
        'short_count': short_count,
        'lsr':         round(long_total / short_total, 3) if short_total > 0 else None,
        'items':       items[:200],
        'buckets':     sorted(buckets.values(), key=lambda x: x['ts_ms']),
        'top10':       top10,
        'ts':          int(now),
        'source':      'Binance Futures Live WebSocket Collector',
    }
    return jsonify(payload)



@app.get("/api/options/ranges")
def options_ranges():
    try:
        fetcher = get_deribit_fetcher()
        persist = request.args.get("persist", "0") == "1"
        payload, status = fetcher.build_dashboard_payload(
            output_path=fetcher.DEFAULT_OUTPUT_PATH,
            persist=persist,
        )
        payload["source"] = "Deribit Range analyzer"
        return jsonify(payload), int(status)
    except Exception as e:
        log.exception("Deribit options route error")
        return jsonify(ok=False, error=str(e), source="Deribit Range analyzer"), 500


@app.get("/api/options/health")
def options_health():
    try:
        fetcher = get_deribit_fetcher()
        saved = fetcher.load_saved_output(fetcher.DEFAULT_OUTPUT_PATH)
        return jsonify(
            ok=True,
            ts=int(time.time()),
            source="Deribit Range analyzer",
            snapshot_available=saved is not None,
        )
    except Exception as e:
        return jsonify(ok=False, ts=int(time.time()), source="Deribit Range analyzer", error=str(e)), 500


def price():
    p = get_price(SYMBOL)
    if p is None:
        return jsonify(error="Failed to fetch price"), 503
    return jsonify(price=p, symbol=SYMBOL, source="Binance Futures")



    """
    Return recent liquidation orders from Binance Futures.
    Source: GET /fapi/v1/forceOrders
    Returns: last 500 liquidations per symbol with aggregated stats.
    """
    now = time.time()
    sym = request.args.get('symbol', SYMBOL).upper()
    lim = min(int(request.args.get('limit', 100)), 1000)

    cache_key = f"{sym}_{lim}"
    if (_liq_cache.get('key') == cache_key and
            _liq_cache['data'] and now - _liq_cache['ts'] < LIQ_TTL):
        return jsonify(_liq_cache['data'])

    try:
        # Fetch last N liquidations for the symbol
        r = _session.get(
            FAPI_BASE + '/fapi/v1/forceOrders',
            params={'symbol': sym, 'autoCloseType': 'LIQUIDATION', 'limit': lim},
            timeout=10,
        )
        r.raise_for_status()
        orders = r.json()

        if not isinstance(orders, list):
            return jsonify(error='Unexpected response from Binance', raw=orders), 502

        items = []
        long_total  = 0.0   # USD value of LONG liquidations (buyers got liq'd)
        short_total = 0.0   # USD value of SHORT liquidations (sellers got liq'd)
        long_count  = 0
        short_count = 0

        for o in orders:
            side      = o.get('side', '')        # BUY = short liq, SELL = long liq
            price_f   = float(o.get('averagePrice') or o.get('price') or 0)
            qty       = float(o.get('origQty', 0))
            usd_val   = price_f * qty
            ts_ms     = int(o.get('time', 0))
            ts_s      = ts_ms // 1000

            item = {
                'time':    ts_s,
                'ts_ms':   ts_ms,
                'side':    side,          # BUY=short liq, SELL=long liq
                'price':   round(price_f, 2),
                'qty':     round(qty, 4),
                'usd':     round(usd_val, 0),
                'symbol':  o.get('symbol', sym),
            }
            items.append(item)

            if side == 'SELL':          # long position liquidated
                long_total  += usd_val
                long_count  += 1
            else:                        # short position liquidated (BUY order)
                short_total += usd_val
                short_count += 1

        # Sort newest first
        items.sort(key=lambda x: x['ts_ms'], reverse=True)

        # 1h buckets for heatmap
        buckets: dict[int, dict] = {}
        for it in items:
            bk = (it['ts_ms'] // (3_600_000)) * 3_600_000  # round to 1h
            if bk not in buckets:
                buckets[bk] = {'ts_ms': bk, 'long_usd': 0, 'short_usd': 0,
                               'long_count': 0, 'short_count': 0}
            if it['side'] == 'SELL':
                buckets[bk]['long_usd']   += it['usd']
                buckets[bk]['long_count'] += 1
            else:
                buckets[bk]['short_usd']  += it['usd']
                buckets[bk]['short_count']+= 1

        bk_list = sorted(buckets.values(), key=lambda x: x['ts_ms'])

        # Top 10 biggest single liquidations
        top10 = sorted(items, key=lambda x: x['usd'], reverse=True)[:10]

        payload = {
            'symbol':       sym,
            'count':        len(items),
            'long_total':   round(long_total, 0),
            'short_total':  round(short_total, 0),
            'long_count':   long_count,
            'short_count':  short_count,
            'lsr':          round(long_total / short_total, 3) if short_total > 0 else None,
            'items':        items[:200],      # last 200 for table
            'buckets':      bk_list,
            'top10':        top10,
            'ts':           int(now),
            'source':       'Binance Futures forceOrders',
        }

        _liq_cache['data'] = payload
        _liq_cache['ts']   = now
        _liq_cache['key']  = cache_key
        return jsonify(payload)

    except requests.RequestException as e:
        log.error('Liquidations fetch error: %s', e)
        return jsonify(error=str(e)), 503
    except Exception as e:
        log.exception('Liquidations unexpected error')
        return jsonify(error=str(e)), 500


@app.get("/api/ws_info")
def ws_info():
    """WebSocket stream URLs for real-time candle updates"""
    symbol = resolve_symbol()
    s = symbol.lower()
    streams = {
        "5m":  f"wss://fstream.binance.com/ws/{s}@kline_5m",
        "15m": f"wss://fstream.binance.com/ws/{s}@kline_15m",
        "1h":  f"wss://fstream.binance.com/ws/{s}@kline_1h",
        "4h":  f"wss://fstream.binance.com/ws/{s}@kline_4h",
        "price": f"wss://fstream.binance.com/ws/{s}@aggTrade",
    }
    return jsonify(streams=streams, symbol=symbol)


@app.get("/health")
def health():
    return jsonify(ok=True, ts=int(time.time()),
                   source="Binance Futures", symbol=SYMBOL)


if __name__ == "__main__":
    log.info("=" * 56)
    log.info("  BTC Dashboard → http://localhost:%s", APP_PORT)
    log.info("  Source: Binance Futures (fapi.binance.com)")
    log.info("  Symbol: %s", SYMBOL)
    log.info("  Indicators: WTMO·MLMI·RSI·MFI·CCI·WR·UO·ADX·CMF")
    log.info("  Logic from: AVSBOT/indicators/indicator_worker.py")
    log.info("=" * 56)
    app.run(host=APP_HOST, port=APP_PORT, debug=False, threaded=True)
