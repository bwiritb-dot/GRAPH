"""
Hermetic tests for the dashboard backend — logic, math and API contracts.
No network: Binance/CoinGlass calls are monkeypatched. Run:  pytest tests/
"""
import os
import sys
import types

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


# ── collapse_liq_profile (pure math) ─────────────────────────────────────────

def _heatmap():
    return {
        "y": [100.0, 200.0, 300.0],
        # [timeIdx, priceIdx, usd]
        "liq": [
            [0, 0, 10.0], [3, 0, 5.0],   # price 100 → 15
            [0, 1, 20.0], [7, 1, 30.0],  # price 200 → 50
            [0, 2, 0],                    # zero usd → skipped
            [0, 9, 100.0],                # priceIdx out of range → skipped
        ],
        "prices": [
            [1_000, "0", "0", "0", "101", "0"],
            [1_000 + 7 * 86_400, "0", "0", "0", "150", "0"],
        ],
        "rangeLow": 90.0, "rangeHigh": 310.0,
    }


def test_collapse_sums_over_time():
    prof = server.collapse_liq_profile(_heatmap())
    levels = {lv["price"]: lv["usd"] for lv in prof["levels"]}
    assert levels == {100.0: 15.0, 200.0: 50.0}   # 300 dropped (0 usd)


def test_collapse_metadata():
    prof = server.collapse_liq_profile(_heatmap())
    assert prof["price"] == 150.0
    assert prof["days"] == 7.0
    assert prof["max_usd"] == 50.0
    assert prof["range"] == [90.0, 310.0]


def test_collapse_ignores_out_of_range_and_short_triples():
    hm = {"y": [1.0], "liq": [[0, 5, 9.0], [0], [0, 0, 7.0]], "prices": []}
    prof = server.collapse_liq_profile(hm)
    assert prof["levels"] == [{"price": 1.0, "usd": 7.0}]


def test_collapse_empty():
    prof = server.collapse_liq_profile({})
    assert prof["levels"] == [] and prof["max_usd"] == 0.0 and prof["price"] is None


# ── resolve_symbol (whitelist) ───────────────────────────────────────────────

@pytest.mark.parametrize("q,expected", [
    ("ETHUSDT", "ETHUSDT"),
    ("ethusdt", "ETHUSDT"),
    ("HACKUSDT", "BTCUSDT"),   # not whitelisted → default
    (None, "BTCUSDT"),
])
def test_resolve_symbol(q, expected):
    path = "/api/liquidations" + (f"?symbol={q}" if q else "")
    with server.app.test_request_context(path):
        assert server.resolve_symbol() == expected


# ── /api/liquidations route (monkeypatched fetch) ────────────────────────────

@pytest.fixture(autouse=True)
def _clear_caches():
    server._liq_cache.clear()
    server._corr_cache.update({"data": None, "ts": 0.0})
    yield


def _fake_cg(heatmap):
    mod = types.SimpleNamespace()
    mod.fetch_liq_heatmap_binance = lambda **kw: heatmap
    mod.parse_heatmap = lambda raw: []
    return mod


def test_liquidations_ok(monkeypatch):
    monkeypatch.setattr(server, "get_coinglass", lambda: _fake_cg(_heatmap()))
    r = server.app.test_client().get("/api/liquidations/heatmap?symbol=BTCUSDT")
    d = r.get_json()
    assert r.status_code == 200 and d["ok"] is True
    assert d["symbol"] == "BTCUSDT" and len(d["records"]) == 2


def test_liquidations_soft_fail_on_none(monkeypatch):
    monkeypatch.setattr(server, "get_coinglass", lambda: _fake_cg(None))
    r = server.app.test_client().get("/api/liquidations/heatmap?symbol=ETHUSDT")
    d = r.get_json()
    assert r.status_code == 502 and d["ok"] is False
    assert "error" in d and d["source"] == "CoinGlass"


# ── /api/data + /api/correlations (monkeypatched klines) ─────────────────────

def _fake_df(n=120):
    idx = np.arange(n, dtype=float)
    close = 100.0 + np.sin(idx / 5.0) * 5.0 + idx * 0.1
    return pd.DataFrame({
        "time": (idx * 3600).astype(int),
        "Open": close, "High": close + 1, "Low": close - 1,
        "Close": close, "Volume": 10.0 + idx,
    })


def test_data_echoes_symbol(monkeypatch):
    monkeypatch.setattr(server, "get_klines", lambda *a, **k: _fake_df())
    d = server.app.test_client().get("/api/data/1h?symbol=ETHUSDT").get_json()
    assert d["instrument"] == "ETHUSDT"
    assert "rsi" in d["indicators"] and len(d["ohlcv"]) == 120


def test_data_invalid_symbol_falls_back(monkeypatch):
    monkeypatch.setattr(server, "get_klines", lambda *a, **k: _fake_df())
    d = server.app.test_client().get("/api/data/1h?symbol=HACKUSDT").get_json()
    assert d["instrument"] == "BTCUSDT"


def test_correlations_btc_first_row(monkeypatch):
    monkeypatch.setattr(server, "get_klines", lambda *a, **k: _fake_df(101))
    d = server.app.test_client().get("/api/correlations").get_json()
    assert d["top10"][0]["symbol"] == "BTC"
    assert d["top10"][0]["correlation"] == 1.0
    assert d["top10"][0]["full_symbol"] == "BTCUSDT"


def test_symbols_endpoint():
    r = server.app.test_client().get("/api/symbols")
    assert r.status_code == 200
    d = r.get_json()
    assert "symbols" in d and "BTCUSDT" in d["symbols"]


def test_alarms_crud():
    client = server.app.test_client()
    # Create alarm
    r = client.post("/api/alarms", json={
        "symbol": "ETHUSDT",
        "type": "price_cross_above",
        "threshold": 4000.0,
        "sound": "chime",
        "channels": ["audio", "telegram"]
    })
    assert r.status_code == 201
    alarm = r.get_json()["alarm"]
    alarm_id = alarm["id"]
    assert alarm["symbol"] == "ETHUSDT"

    # List alarms
    r = client.get("/api/alarms?symbol=ETHUSDT")
    assert any(a["id"] == alarm_id for a in r.get_json()["alarms"])

    # Toggle alarm
    r = client.post(f"/api/alarms/{alarm_id}/toggle")
    assert r.status_code == 200
    assert r.get_json()["alarm"]["enabled"] is False

    # Delete alarm
    r = client.delete(f"/api/alarms/{alarm_id}")
    assert r.status_code == 200


def test_auth_verify():
    client = server.app.test_client()
    # Valid seed phrase
    r = client.post("/api/auth/verify", json={"phrase": "crypto datex pro alpha"})
    assert r.status_code == 200
    assert r.get_json()["tier"] == "PRO"

    # Invalid seed phrase
    r = client.post("/api/auth/verify", json={"phrase": "wrong"})
    assert r.status_code == 401


def test_timeframe_contracts():
    assert "1d" not in server.TF_INTERVAL
    assert "5m" in server.TF_INTERVAL
    assert "1d" in server.GOLD_TF_INTERVAL


def test_email_api():
    client = server.app.test_client()
    # Save config
    r = client.post("/api/email/config", json={
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "use_tls": True,
        "user": "test@example.com",
        "to": "trader@example.com",
        "password": "secretpassword"
    })
    assert r.status_code == 200
    # Read config (password masked)
    r = client.get("/api/email/config")
    assert r.status_code == 200
    cfg = r.get_json()
    assert cfg["to"] == "trader@example.com"
    assert cfg["has_password"] is True


def test_alarm_trigger_evaluation():
    client = server.app.test_client()
    r = client.post("/api/alarms", json={
        "symbol": "SOLUSDT",
        "type": "price_cross_above",
        "threshold": 200.0,
        "sound": "siren",
        "channels": ["audio"]
    })
    alarm = r.get_json()["alarm"]
    alarm_id = alarm["id"]

    # Trigger evaluate via _alarms manager
    res = server._alarms.evaluate_tick(
        symbol="SOLUSDT",
        price=205.0,
        indicators={},
        prev_price=195.0
    )
    assert any(t["id"] == alarm_id for t in res)

    # Cleanup
    server._alarms.delete(alarm_id)


