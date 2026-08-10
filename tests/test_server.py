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
    mod.fetch_heatmap = lambda **kw: ({"data": heatmap} if heatmap is not None else None)
    return mod


def test_liquidations_ok(monkeypatch):
    monkeypatch.setattr(server, "get_coinglass", lambda: _fake_cg(_heatmap()))
    r = server.app.test_client().get("/api/liquidations?symbol=BTCUSDT")
    d = r.get_json()
    assert r.status_code == 200 and d["ok"] is True
    assert d["symbol"] == "BTCUSDT" and len(d["levels"]) == 2


def test_liquidations_soft_fail_on_none(monkeypatch):
    monkeypatch.setattr(server, "get_coinglass", lambda: _fake_cg(None))
    r = server.app.test_client().get("/api/liquidations?symbol=ETHUSDT")
    d = r.get_json()
    assert r.status_code == 200 and d["ok"] is False
    assert d["levels"] == [] and "error" in d and d["symbol"] == "ETHUSDT"


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
