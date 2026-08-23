import os
import sys
import json
import time
import pytest
import sqlite3
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import macro
import alarms
import email_notify


def test_macro_calendar_adaptive_poll(tmp_path, monkeypatch):
    db_path = str(tmp_path / "macro_test.db")
    meta_path = str(tmp_path / "macro_meta.json")

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump({"test_id": {"name": "CPI YoY", "importance": 3, "country": "US"}}, f)

    lock = threading.Lock()
    def get_conn():
        return sqlite3.connect(db_path)

    mc = macro.MacroCalendar(get_conn, lock, meta_path)
    now = int(time.time())

    # Insert an event happening right now without actual value
    evt_data = {
        "id": "evt_1", "ts": now, "country": "US", "importance": 3,
        "title": "CPI YoY", "actual": None, "forecast": 3.2, "previous": 3.1,
        "source": "tradingview"
    }
    with lock, get_conn() as c:
        c.execute("""
            INSERT INTO macro_events (id, ts, country, importance, title, actual, forecast, previous, source, raw)
            VALUES ('evt_1', ?, 'US', 3, 'CPI YoY', NULL, 3.2, 3.1, 'tradingview', ?)
        """, (now, json.dumps(evt_data)))

    # Event within -300s to +60s without actual value
    mc._load_from_db()
    with mc._lock:
        pending = [
            e for e in mc._events
            if (now - 300 <= e["ts"] <= now + 60) and e.get("actual") is None
        ]
    assert len(pending) == 1

    # When actual is filled, pending list is empty
    evt_data["actual"] = 3.3
    with lock, get_conn() as c:
        c.execute("UPDATE macro_events SET actual = 3.3, raw = ? WHERE id = 'evt_1'", (json.dumps(evt_data),))
    mc._load_from_db()
    with mc._lock:
        pending_after = [
            e for e in mc._events
            if (now - 300 <= e["ts"] <= now + 60) and e.get("actual") is None
        ]
    assert len(pending_after) == 0


def test_email_notifier_config(tmp_path):
    cfg_file = str(tmp_path / "email_cfg.json")
    notifier = email_notify.EmailNotifier(cfg_file)
    assert notifier.config["enabled"] is False

    # Update config
    res = notifier.update({
        "enabled": True,
        "smtp_host": "smtp.office365.com",
        "smtp_port": 587,
        "user": "analyst@cryptodatex.com",
        "to": "team@cryptodatex.com",
        "password": "mySecurePassword"
    })
    assert res["enabled"] is True
    assert res["smtp_host"] == "smtp.office365.com"
    assert res["has_password"] is True

    # Reload from file to ensure persistence
    new_notifier = email_notify.EmailNotifier(cfg_file)
    assert new_notifier.config["enabled"] is True
    assert new_notifier.config["to"] == "team@cryptodatex.com"


def test_alarms_manager_full_cycle(tmp_path):
    manager = alarms.AlarmsManager()
    alarm = manager.create({
        "symbol": "BTCUSDT",
        "type": "price_cross_above",
        "threshold": 95000.0,
        "sound": "laser",
        "channels": ["audio"]
    })
    assert alarm["symbol"] == "BTCUSDT"
    assert alarm["sound"] == "laser"

    # Test update
    updated = manager.update(alarm["id"], {"threshold": 96000.0, "sound": "chime"})
    assert updated["threshold"] == 96000.0
    assert updated["sound"] == "chime"

    # Test toggle
    toggled = manager.toggle(alarm["id"])
    assert toggled["enabled"] is False
    toggled_back = manager.toggle(alarm["id"])
    assert toggled_back["enabled"] is True

    # Test trigger evaluation
    hits = manager.evaluate_tick(
        symbol="BTCUSDT",
        price=96500.0,
        prev_price=95500.0
    )
    assert len(hits) == 1
    assert hits[0]["id"] == alarm["id"]

    # Delete
    assert manager.delete(alarm["id"]) is True
    assert manager.get_by_id(alarm["id"]) is None
