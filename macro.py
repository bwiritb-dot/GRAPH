#!/usr/bin/env python3
"""Macro economic calendar.

Source: TradingView's public economic-calendar endpoint. Picked over the
alternatives after testing all of them live:

  * ForexFactory's free JSON feed has no `actual` field at all, its
    `nextweek`/`lastweek` files now 404, and it rate-limits at a handful of
    requests — so it cannot answer "what came out?" or "what's tomorrow?"
    across a week boundary.
  * FRED's API gives release *dates* but no time of day, which is useless
    for marking an intraday chart.
  * Finnhub / FMP / Trading Economics all want an API key.

TradingView needs no key, accepts an arbitrary date range, and returns
actual/forecast/previous plus an importance rank and the issuing agency.

Events are joined against macro_meta.json — generated from the user's
spreadsheet — to attach a crypto-impact score and the reaction guidance.
"""

import os
import json
import time
import logging
import sqlite3
import threading
import datetime as dt
from urllib.request import Request, urlopen

log = logging.getLogger(__name__)

TV_URL = "https://economic-calendar.tradingview.com/events"
TV_HEADERS = {
    # The endpoint checks Origin/Referer; without them it returns an error.
    "Origin": "https://www.tradingview.com",
    "Referer": "https://www.tradingview.com/",
    "User-Agent": "Mozilla/5.0",
}

COUNTRIES = "US,EU,DE,FR,IT,ES,CN,JP"   # US + eurozone aggregate + its 4 largest members + CN/JP
MIN_IMPORTANCE = 0          # 1 = high (3*), 0 = medium (2*), -1 = low (1*) — keep 2*+3*
REFRESH_SECONDS = 900       # 15 min
LOOKBACK_DAYS = 3
LOOKAHEAD_DAYS = 21


class MacroCalendar:
    """Polls the calendar in the background and mirrors it into SQLite so a
    restart (or a TradingView outage) still leaves the panel populated."""

    def __init__(self, db_connect, db_lock, meta_path: str):
        self._db_connect = db_connect
        self._db_lock = db_lock
        self._lock = threading.Lock()
        self._events: list[dict] = []
        self._stop = False
        self.last_fetch = 0.0
        self.last_error: str | None = None
        self.meta = self._load_meta(meta_path)
        self._init_db()
        self._load_from_db()

    # ── metadata ────────────────────────────────────────────────────────
    @staticmethod
    def _load_meta(path: str) -> dict:
        try:
            with open(path, encoding="utf-8") as fh:
                m = json.load(fh)
            m["rows"] = {int(k): v for k, v in m["rows"].items()}
            return m
        except Exception as e:
            log.warning("[macro] no metadata (%s): %s", path, e)
            return {"rows": {}, "by_ticker": {}, "by_keyword": []}

    def _meta_for(self, ev: dict) -> dict | None:
        """Attach the spreadsheet row describing this indicator.

        Matched by ticker first, then by title keyword: the calendar and the
        spreadsheet use different TradingView naming schemes
        (ECONOMICS:USIRYY vs ECONOMIC:USCPI), so the tickers do not line up
        directly and an explicit table beats fuzzy matching.
        """
        ticker = (ev.get("ticker") or "").split(":")[-1].upper()
        row_n = self.meta["by_ticker"].get(ticker)
        # Keyword fallback is US-only: titles like "Germany Inflation Rate" or
        # "China PPI" also contain these words, and matching them would attach
        # the spreadsheet's USD/Fed-specific guidance to a non-US release.
        if row_n is None and (ev.get("country") or "").upper() == "US":
            title = (ev.get("title") or "").lower()
            for entry in self.meta["by_keyword"]:
                if any(w in title for w in entry["words"]):
                    row_n = entry["row"]
                    break
        if row_n is None:
            return None
        r = self.meta["rows"].get(int(row_n))
        if not r:
            return None
        return {
            "name": r["name"],
            "category": r["category"],
            "power_crypto": r["power_crypto"],
            "power_stocks": r["power_stocks"],
            "criterion": r["criterion"],
            "if_up": r["crypto_if_up"],
            "if_down": r["crypto_if_down"],
            "caveats": r["caveats"],
            "watch_with": r["watch_with"],
            "source_url": r["source_url"],
        }

    # ── persistence ─────────────────────────────────────────────────────
    def _init_db(self):
        with self._db_lock, self._db_connect() as c:
            c.execute("""
                CREATE TABLE IF NOT EXISTS macro_events (
                    id         TEXT PRIMARY KEY,
                    ts         INTEGER NOT NULL,
                    country    TEXT,
                    title      TEXT,
                    ticker     TEXT,
                    importance INTEGER,
                    actual     REAL,
                    forecast   REAL,
                    previous   REAL,
                    unit       TEXT,
                    period     TEXT,
                    source     TEXT,
                    raw        TEXT
                )
            """)
            c.execute("CREATE INDEX IF NOT EXISTS idx_macro_ts ON macro_events(ts)")

    def _save(self, events: list[dict]):
        rows = [(
            e["id"], e["ts"], e["country"], e["title"], e.get("ticker"),
            e["importance"], e.get("actual"), e.get("forecast"), e.get("previous"),
            e.get("unit"), e.get("period"), e.get("source"), json.dumps(e, ensure_ascii=False),
        ) for e in events]
        with self._db_lock, self._db_connect() as c:
            c.executemany(
                "INSERT OR REPLACE INTO macro_events "
                "(id, ts, country, title, ticker, importance, actual, forecast, "
                " previous, unit, period, source, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )

    def _load_from_db(self):
        cutoff = int(time.time()) - LOOKBACK_DAYS * 86400
        try:
            with self._db_lock, self._db_connect() as c:
                raws = c.execute(
                    "SELECT raw FROM macro_events WHERE ts >= ? ORDER BY ts", (cutoff,)
                ).fetchall()
            with self._lock:
                self._events = [json.loads(r[0]) for r in raws]
            if raws:
                log.info("[macro] restored %d events from disk", len(raws))
        except Exception as e:
            log.warning("[macro] restore failed: %s", e)

    # ── fetching ────────────────────────────────────────────────────────
    def _fetch(self) -> list[dict]:
        now = dt.datetime.now(dt.timezone.utc)
        frm = (now - dt.timedelta(days=LOOKBACK_DAYS)).strftime("%Y-%m-%dT00:00:00.000Z")
        to = (now + dt.timedelta(days=LOOKAHEAD_DAYS)).strftime("%Y-%m-%dT00:00:00.000Z")
        url = f"{TV_URL}?from={frm}&to={to}&countries={COUNTRIES}"
        with urlopen(Request(url, headers=TV_HEADERS), timeout=30) as r:
            payload = json.load(r)
        if payload.get("status") != "ok":
            raise RuntimeError(f"calendar status={payload.get('status')}")

        out = []
        for e in payload.get("result", []):
            if (e.get("importance") if e.get("importance") is not None else -1) < MIN_IMPORTANCE:
                continue
            try:
                ts = int(dt.datetime.fromisoformat(
                    e["date"].replace("Z", "+00:00")).timestamp())
            except Exception:
                continue
            ev = {
                "id": str(e.get("id") or f"{e.get('ticker')}-{ts}"),
                "ts": ts,
                "country": e.get("country"),
                "title": e.get("title"),
                "ticker": e.get("ticker"),
                "importance": e.get("importance"),
                "actual": e.get("actual"),
                "forecast": e.get("forecast"),
                "previous": e.get("previous"),
                "unit": e.get("scale") or e.get("unit"),
                "period": e.get("period"),
                "source": e.get("source"),
                "source_url": e.get("source_url"),
                "comment": e.get("comment"),
            }
            ev["meta"] = self._meta_for(e)
            out.append(ev)
        out.sort(key=lambda x: x["ts"])
        return out

    def refresh(self) -> bool:
        try:
            events = self._fetch()
        except Exception as e:
            self.last_error = str(e)
            log.warning("[macro] fetch failed: %s", e)
            return False
        with self._lock:
            self._events = events
        self.last_fetch = time.time()
        self.last_error = None
        try:
            self._save(events)
        except Exception as e:
            log.warning("[macro] save failed: %s", e)
        log.info("[macro] %d events (importance >= %d, %s)",
                 len(events), MIN_IMPORTANCE, COUNTRIES)
        return True

    def _loop(self):
        while not self._stop:
            self.refresh()
            time.sleep(REFRESH_SECONDS)

    def start(self):
        threading.Thread(target=self._loop, name="macro-calendar", daemon=True).start()
        return self

    # ── queries ─────────────────────────────────────────────────────────
    def all(self) -> list[dict]:
        with self._lock:
            return list(self._events)

    def window(self, tz_offset_minutes: int = 0, days: int = 2, start_offset: int = 0) -> list[dict]:
        """Events falling on today+start_offset .. today+start_offset+days-1,
        in the caller's timezone.

        The offset is the viewer's, not the server's: "today" has to mean the
        same day the user sees on their own clock. `start_offset` lets the
        panel page the window forward/back a day at a time while keeping
        `day_offset` (in the returned events) relative to the *real* today,
        so "Сегодня"/"Завтра" labels stay correct however the window is paged.
        """
        # JS Date.getTimezoneOffset() returns UTC-minus-local in minutes (e.g.
        # -180 for Moscow, UTC+3) — so local time is UTC MINUS that offset,
        # not plus. Adding it (as this used to) put "today" up to 2x the
        # timezone's own offset away from the viewer's actual local date,
        # which is why non-UTC viewers saw events missing or on the wrong day.
        off = dt.timedelta(minutes=-tz_offset_minutes)
        local_today = (dt.datetime.now(dt.timezone.utc) + off).date()
        first_day = local_today + dt.timedelta(days=start_offset)
        last_day = first_day + dt.timedelta(days=days - 1)
        out = []
        for e in self.all():
            local = dt.datetime.fromtimestamp(e["ts"], dt.timezone.utc) + off
            if first_day <= local.date() <= last_day:
                d = dict(e)
                d["day_offset"] = (local.date() - local_today).days
                out.append(d)
        return out

    def next_upcoming(self, within_seconds: int) -> list[dict]:
        now = time.time()
        return [e for e in self.all() if now < e["ts"] <= now + within_seconds]

    def status(self) -> dict:
        return {
            "count": len(self.all()),
            "lastFetch": int(self.last_fetch) or None,
            "ageSeconds": int(time.time() - self.last_fetch) if self.last_fetch else None,
            "error": self.last_error,
            "source": "TradingView economic calendar",
            "countries": COUNTRIES,
            "minImportance": MIN_IMPORTANCE,
        }
