#!/usr/bin/env python3
"""
Custom Price, Indicator & Volume Alarms Manager for CryptoDATEX.
Persisted in SQLite (dashboard.db), supports sound selection, Telegram & Email channels.
"""

import os
import json
import time
import uuid
import logging
import sqlite3
import threading

log = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dashboard.db")
_db_lock = threading.Lock()


def db_connect():
    conn = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_alarms_db():
    with _db_lock, db_connect() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS alarms (
                id                TEXT PRIMARY KEY,
                symbol            TEXT NOT NULL,
                type              TEXT NOT NULL,
                threshold         REAL,
                sound             TEXT NOT NULL DEFAULT 'ping',
                channels          TEXT NOT NULL DEFAULT 'audio,telegram',
                enabled           INTEGER NOT NULL DEFAULT 1,
                triggered_count   INTEGER NOT NULL DEFAULT 0,
                last_triggered_at INTEGER DEFAULT NULL,
                created_at        INTEGER NOT NULL,
                params            TEXT NOT NULL DEFAULT '{}'
            )
        """)
        c.execute("CREATE INDEX IF NOT EXISTS idx_alarms_symbol ON alarms(symbol)")


init_alarms_db()


class AlarmsManager:
    def __init__(self, telegram_notifier=None, email_notifier=None):
        self.telegram = telegram_notifier
        self.email = email_notifier
        self._lock = threading.Lock()
        self._cooldowns: dict[str, float] = {}  # alarm_id -> last_fire_time

    def get_all(self, symbol: str = None) -> list[dict]:
        with _db_lock, db_connect() as c:
            if symbol:
                rows = c.execute(
                    "SELECT id, symbol, type, threshold, sound, channels, enabled, "
                    "triggered_count, last_triggered_at, created_at, params "
                    "FROM alarms WHERE symbol = ? ORDER BY created_at DESC",
                    (symbol.upper(),),
                ).fetchall()
            else:
                rows = c.execute(
                    "SELECT id, symbol, type, threshold, sound, channels, enabled, "
                    "triggered_count, last_triggered_at, created_at, params "
                    "FROM alarms ORDER BY created_at DESC"
                ).fetchall()

        out = []
        for r in rows:
            out.append({
                "id": r[0],
                "symbol": r[1],
                "type": r[2],
                "threshold": r[3],
                "sound": r[4],
                "channels": r[5].split(",") if r[5] else [],
                "enabled": bool(r[6]),
                "triggered_count": r[7],
                "last_triggered_at": r[8],
                "created_at": r[9],
                "params": json.loads(r[10]) if r[10] else {},
            })
        return out

    def create(self, data: dict) -> dict:
        alarm_id = str(uuid.uuid4())[:8]
        symbol = (data.get("symbol") or "BTCUSDT").upper()
        alarm_type = data.get("type", "price_cross_above")
        threshold = float(data.get("threshold", 0.0)) if data.get("threshold") is not None else None
        sound = data.get("sound", "ping")
        channels = ",".join(data.get("channels", ["audio", "telegram"]))
        enabled = 1 if data.get("enabled", True) else 0
        created_at = int(time.time())
        params = json.dumps(data.get("params", {}), ensure_ascii=False)

        with _db_lock, db_connect() as c:
            c.execute(
                "INSERT INTO alarms (id, symbol, type, threshold, sound, channels, enabled, created_at, params) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (alarm_id, symbol, alarm_type, threshold, sound, channels, enabled, created_at, params),
            )

        log.info("[alarms] Created alarm %s (%s %s %s)", alarm_id, symbol, alarm_type, threshold)
        return self.get_by_id(alarm_id)

    def get_by_id(self, alarm_id: str) -> dict | None:
        with _db_lock, db_connect() as c:
            r = c.execute(
                "SELECT id, symbol, type, threshold, sound, channels, enabled, "
                "triggered_count, last_triggered_at, created_at, params "
                "FROM alarms WHERE id = ?",
                (alarm_id,),
            ).fetchone()
        if not r:
            return None
        return {
            "id": r[0],
            "symbol": r[1],
            "type": r[2],
            "threshold": r[3],
            "sound": r[4],
            "channels": r[5].split(",") if r[5] else [],
            "enabled": bool(r[6]),
            "triggered_count": r[7],
            "last_triggered_at": r[8],
            "created_at": r[9],
            "params": json.loads(r[10]) if r[10] else {},
        }

    def update(self, alarm_id: str, data: dict) -> dict | None:
        curr = self.get_by_id(alarm_id)
        if not curr:
            return None

        symbol = data.get("symbol", curr["symbol"]).upper()
        alarm_type = data.get("type", curr["type"])
        threshold = float(data.get("threshold")) if data.get("threshold") is not None else curr["threshold"]
        sound = data.get("sound", curr["sound"])
        channels = ",".join(data.get("channels", curr["channels"]))
        enabled = (1 if data["enabled"] else 0) if "enabled" in data else (1 if curr["enabled"] else 0)
        params = json.dumps(data.get("params", curr["params"]), ensure_ascii=False)

        with _db_lock, db_connect() as c:
            c.execute(
                "UPDATE alarms SET symbol=?, type=?, threshold=?, sound=?, channels=?, enabled=?, params=? "
                "WHERE id=?",
                (symbol, alarm_type, threshold, sound, channels, enabled, params, alarm_id),
            )

        log.info("[alarms] Updated alarm %s", alarm_id)
        return self.get_by_id(alarm_id)

    def delete(self, alarm_id: str) -> bool:
        with _db_lock, db_connect() as c:
            c.execute("DELETE FROM alarms WHERE id = ?", (alarm_id,))
        log.info("[alarms] Deleted alarm %s", alarm_id)
        return True

    def toggle(self, alarm_id: str) -> dict | None:
        curr = self.get_by_id(alarm_id)
        if not curr:
            return None
        new_state = not curr["enabled"]
        return self.update(alarm_id, {"enabled": new_state})

    def record_trigger(self, alarm_id: str, message: str = ""):
        now = int(time.time())
        self._cooldowns[alarm_id] = now
        with _db_lock, db_connect() as c:
            c.execute(
                "UPDATE alarms SET triggered_count = triggered_count + 1, last_triggered_at = ? WHERE id = ?",
                (now, alarm_id),
            )
        alarm = self.get_by_id(alarm_id)
        if not alarm:
            return

        channels = alarm.get("channels", [])
        body = f"🔔 <b>CryptoDATEX Alarm Triggered</b>\n<b>{alarm['symbol']}</b>: {message}"

        # Send Telegram if enabled in channels
        if "telegram" in channels and self.telegram:
            try:
                self.telegram.send_message(body)
            except Exception as e:
                log.warning("[alarms] Telegram dispatch error: %s", e)

        # Send Email if enabled in channels
        if "email" in channels and self.email:
            try:
                self.email.send_notification(
                    subject=f"🔔 Alarm: {alarm['symbol']} ({alarm['type']})",
                    html_content=f"<h3>CryptoDATEX Alarm Triggered</h3><p><b>{alarm['symbol']}</b>: {message}</p>",
                    text_content=f"CryptoDATEX Alarm Triggered: {alarm['symbol']} - {message}",
                )
            except Exception as e:
                log.warning("[alarms] Email dispatch error: %s", e)

    def evaluate_tick(self, symbol: str, price: float, indicators: dict = None, prev_price: float = None) -> list[dict]:
        triggered = []
        alarms = self.get_all(symbol)
        now = time.time()
        for a in alarms:
            if not a.get("enabled"):
                continue
            aid = a["id"]
            if aid in self._cooldowns and now - self._cooldowns[aid] < 60:
                continue
            atype = a.get("type")
            thresh = a.get("threshold")
            if thresh is None:
                continue

            hit = False
            msg = ""
            if atype == "price_cross_above" and prev_price is not None:
                if prev_price <= thresh < price:
                    hit = True
                    msg = f"Price crossed above {thresh} (current: {price})"
            elif atype == "price_cross_below" and prev_price is not None:
                if prev_price >= thresh > price:
                    hit = True
                    msg = f"Price crossed below {thresh} (current: {price})"
            elif atype == "price_above" and price >= thresh:
                hit = True
                msg = f"Price is above {thresh} (current: {price})"
            elif atype == "price_below" and price <= thresh:
                hit = True
                msg = f"Price is below {thresh} (current: {price})"
            elif indicators and atype.startswith("rsi_"):
                rsi_val = indicators.get("rsi")
                if isinstance(rsi_val, list) and rsi_val:
                    r = rsi_val[-1]
                    if r is not None:
                        if atype == "rsi_above" and r >= thresh:
                            hit = True
                            msg = f"RSI is above {thresh} (current: {r:.1f})"
                        elif atype == "rsi_below" and r <= thresh:
                            hit = True
                            msg = f"RSI is below {thresh} (current: {r:.1f})"

            if hit:
                self.record_trigger(aid, msg)
                triggered.append({"id": aid, "message": msg, "sound": a.get("sound")})
        return triggered
