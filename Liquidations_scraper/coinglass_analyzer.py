"""
coinglass_cracked.py  —  CoinGlass Heatmap Scraper (fully decoded)
====================================================================
Decryption algorithm reverse-engineered from _app-71f6b040bd9900dd.js

ALGORITHM SUMMARY
─────────────────
Request:
  data_param = AES_ECB_PKCS7_encrypt(f"{unix_ts},{TOTP}", MASTER_KEY)
  cache_ts_v2 = str(int(time.time() * 1000))   ← millisecond timestamp
  obe = <session token from DevTools — only manual thing needed>

Response decryption (interceptor switch order: 4|6|7|1|2|3|0|5):
  case 4:  a  = ""
  case 6:  if v==0:  a = request.headers["cache-ts-v2"]
  case 7:  if v==2:  a = response.headers["time"]
  case 1:  if v==1:  a = ie(request_url)  → endpoint path
  case 2:  if v==55: a = "170b070da9654622"
  case 3:  if v==66: a = "d6537d845a964081"
  case 0:  if v==77: a = "863f08689c97435b"
  case 5:  s  = btoa(a)
  then:    s  = s[:16]
           s  = re(response.headers.user, s)  → AES→Hex→inflate→str
           o  = re(response.data.data, s[:16]) → gives JSON string
           data = JSON.parse(o)

re(ciphertext_b64, key_str):
  raw   = AES_ECB_PKCS7_decrypt(ciphertext_b64, key_str[:16])
  hex_s = raw.hex()
  bytes = bytes.fromhex(hex_s)          # = raw (same thing)
  inf   = zlib_inflate(bytes)            # Gt.ZP.inflate in JS
  s     = fromCharCode(inf)              # UTF-8 decode
  return s.strip('"')

DEPENDENCIES
────────────
  pip install requests pycryptodome pyotp

MANUAL STEP (once every few days)
──────────────────────────────────
  DevTools → Network → liqHeatMap request → copy 'obe' header value
"""

import base64
import json
import logging
import os
import random
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path

import pyotp
import requests
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad, unpad

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Constants from JS source (stable until CoinGlass redeploys) ───────────────
_TOTP_SECRET  = "I65VU7K5ZQL7WB4E"
_MASTER_KEY   = "1f68efd73f8d4921acc0dead41dd39bc"
_BASE_URL     = "https://capi.coinglass.com"
_KNOWN_JS_HASH = "dd73626052eeca65"   # _app-<hash>.js — update when CoinGlass redeploys

# ── Your session token (only thing that needs manual refresh) ─────────────────
# Refresh from DevTools → Network → liqHeatMap request → 'obe' request header.
# Override without editing the file via the COINGLASS_OBE environment variable.
OBE = os.getenv("COINGLASS_OBE", "s_1c077abffefb4638bb416690304b120e")

OUTPUT_DIR = Path("output")   # reassigned to a timestamped subfolder in __main__
OUTPUT_DIR.mkdir(exist_ok=True)


def check_js_bundle() -> None:
    """Warn if CoinGlass has redeployed a new JS bundle since last reverse-engineering."""
    try:
        r = requests.get(
            "https://www.coinglass.com",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=10,
        )
        import re
        m = re.search(r'/_next/static/chunks/pages/_app-([a-f0-9]+)\.js', r.text)
        if not m:
            log.warning("⚠️  Could not find _app-*.js in CoinGlass HTML — site structure may have changed.")
            return
        current = m.group(1)
        if current != _KNOWN_JS_HASH:
            log.warning("=" * 60)
            log.warning(f"⚠️  JS BUNDLE CHANGED: {_KNOWN_JS_HASH} → {current}")
            log.warning("   Decryption constants may be stale. If requests fail,")
            log.warning("   update _KNOWN_JS_HASH and re-run the JS decoder.")
            log.warning("=" * 60)
        else:
            log.info(f"✅ JS bundle unchanged ({current[:8]}…)")
    except Exception as e:
        log.debug(f"JS bundle check failed (non-fatal): {e}")


# ── Global Rate Limiter ────────────────────────────────────────────────────────
class RateLimiter:
    """Enforces minimum interval between API calls to different endpoints."""
    def __init__(self, min_interval_seconds: float = 6.0):
        self.min_interval = min_interval_seconds
        self.last_request_time = 0.0

    def wait(self):
        """Block until min_interval has passed since last call."""
        elapsed = time.time() - self.last_request_time
        if elapsed < self.min_interval:
            sleep_time = self.min_interval - elapsed
            log.debug(f"Rate limiter: sleeping {sleep_time:.1f}s")
            time.sleep(sleep_time)
        self.last_request_time = time.time()

global_limiter = RateLimiter(min_interval_seconds=6.0)


# ══════════════════════════════════════════════════════════════════════════════
#  CRYPTO PRIMITIVES  (matching JS CryptoJS + pako exactly)
# ══════════════════════════════════════════════════════════════════════════════

def _aes_ecb_encrypt(plaintext: str, key: str) -> str:
    """AES-ECB-PKCS7 encrypt. Returns base64 string."""
    k = key.encode("utf-8")
    c = AES.new(k, AES.MODE_ECB)
    return base64.b64encode(c.encrypt(pad(plaintext.encode(), 16))).decode()


def _aes_ecb_decrypt_raw(ciphertext_b64: str, key_str: str) -> bytes:
    """
    AES-ECB-PKCS7 decrypt.
    Matches: CryptoJS.AES.decrypt(ct, enc.Utf8.parse(key), {ECB, PKCS7})
    Returns raw plaintext bytes (PKCS7-unpadded).
    """
    k   = key_str.encode("utf-8")[:16]   # enc.Utf8.parse → bytes, AES-128
    raw = base64.b64decode(ciphertext_b64)
    c   = AES.new(k, AES.MODE_ECB)
    dec = c.decrypt(raw)
    try:
        dec = unpad(dec, 16)
    except Exception:
        pass
    return dec


def _inflate(data: bytes) -> bytes:
    """
    Zlib inflate — matches Gt.ZP.inflate() in JS (pako library).
    Tries zlib format first, then raw deflate.
    """
    for wbits in [15, -15, 47]:
        try:
            return zlib.decompress(data, wbits)
        except Exception:
            continue
    raise ValueError(f"Could not inflate {len(data)} bytes")


def _from_char_code(data: bytes) -> str:
    """
    Matches JS: String.fromCharCode.apply(null, inflated) + decodeURIComponent(escape(s))
    Essentially: interpret raw bytes as Latin-1, then URI-decode to UTF-8.
    """
    # JS's escape() + decodeURIComponent() on raw bytes = UTF-8 decode
    return data.decode("utf-8", errors="replace")


def re_fn(ciphertext_b64: str, key_str: str, retries: int = 2) -> str | None:
    """
    Replicates the JS re(t, e) function with retry logic for transient failures.
      1. AES-ECB-PKCS7 decrypt
      2. .toString(enc.Hex)  →  hex string
      3. ne(): hex → bytes → inflate → fromCharCode → decodeURIComponent
      4. strip leading/trailing quotes

    Retries on transient errors (zlib decompression failures).
    """
    for attempt in range(1, retries + 1):
        try:
            raw_bytes = _aes_ecb_decrypt_raw(ciphertext_b64, key_str)
            inflated  = _inflate(raw_bytes)
            result    = _from_char_code(inflated)
            return result.strip('"').strip("'")
        except ValueError as e:
            if attempt < retries:
                log.debug(f"re_fn transient error (attempt {attempt}/{retries}): {e}")
                time.sleep(0.5 * attempt)
                continue
            log.error(f"re_fn failed after {retries} retries: {e}")
            return None
        except Exception as e:
            log.error(f"re_fn permanent error: {e}")
            return None
    return None


# ══════════════════════════════════════════════════════════════════════════════
#  REQUEST GENERATION
# ══════════════════════════════════════════════════════════════════════════════

def _generate_data_param() -> str:
    """
    Replicates JS function a():
      t    = unix timestamp (seconds)
      code = TOTP(secret, t, step=30)
      payload = f"{t},{code}"
      return AES_ECB_encrypt(payload, MASTER_KEY)
    """
    t    = int(time.time())
    code = pyotp.TOTP(_TOTP_SECRET, interval=30).now()
    return _aes_ecb_encrypt(f"{t},{code}", _MASTER_KEY)


def _build_headers(cache_ts_v2: str) -> dict:
    return {
        "User-Agent":     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept":         "application/json",
        "Accept-Language":"en-US,en;q=0.9",
        "Accept-Encoding":"gzip, deflate, br",
        "Origin":         "https://www.coinglass.com",
        "Referer":        "https://www.coinglass.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "cache-ts-v2":    cache_ts_v2,   # ← KEY: used in decryption derivation
        "encryption":     "true",
        "language":       "en",
        "obe":            OBE,
    }


# ══════════════════════════════════════════════════════════════════════════════
#  RESPONSE DECRYPTION  (interceptor switch order: 1→4→2→3→0→6→5)
# ══════════════════════════════════════════════════════════════════════════════

def decrypt_response(
    encrypted_data: str,
    user_header:    str,
    cache_ts_v2:    str,
    v_header:       str = "0",
    endpoint:       str = "",
    time_header:    str = "",
) -> dict | None:
    """
    Full response decryption pipeline — Xt() switch order: 4|6|7|1|2|3|0|5

    v=0:  seed = btoa(cache_ts_v2)           (request header)
    v=1:  seed = btoa(endpoint)              (request path)
    v=2:  seed = btoa(response.headers.time) (response "time" header)
    v=55: seed = btoa("170b070da9654622")    (hardcoded constant)
    v=66: seed = btoa("d6537d845a964081")    (hardcoded constant)
    v=77: seed = btoa("863f08689c97435b")    (hardcoded constant)

    Then: seed = seed[:16]
    case 3: intermediate = re(user_header, seed)
    case 0: plaintext    = re(encrypted_data, intermediate[:16])
    case 6: return JSON.parse(plaintext)
    """
    _HARDCODED = {
        "55": "170b070da9654622",
        "66": "d6537d845a964081",
        "77": "863f08689c97435b",
    }

    _KNOWN_V = {"0", "1", "2", "55", "66", "77"}
    if v_header not in _KNOWN_V:
        log.error(
            f"  UNKNOWN v_header={v_header!r} — CoinGlass likely redeployed. "
            "Re-run the JS decoder to extract new constants."
        )
        return None

    if v_header == "1":
        seed = endpoint
    elif v_header == "2":
        seed = time_header
    elif v_header in _HARDCODED:
        seed = _HARDCODED[v_header]
    else:
        seed = cache_ts_v2  # v=0

    s = base64.b64encode(seed.encode()).decode()

    # Case 2: s = s.substring(0, 16)
    s = s[:16]

    log.debug(f"  intermediate key seed: {repr(s)}")

    # Case 3: s = re(user_header, s)
    intermediate = re_fn(user_header, s)
    if intermediate is None:
        log.error("  Case 3 failed: could not decrypt user_header")
        return None

    log.debug(f"  intermediate key: {repr(intermediate[:20])}")

    # Case 0: o = re(encrypted_data, s)  where s is now the intermediate
    # Note: re() uses key_str[:16] internally
    final_key = intermediate[:16]
    plaintext = re_fn(encrypted_data, final_key)

    if plaintext is None:
        log.error("  Case 0 failed: could not decrypt response data")
        return None

    # Case 6: JSON.parse(o)
    try:
        return json.loads(plaintext)
    except json.JSONDecodeError as e:
        log.error(f"  JSON parse failed: {e}")
        log.error(f"  Plaintext preview: {repr(plaintext[:100])}")
        return None


# ══════════════════════════════════════════════════════════════════════════════
#  CORE FETCH
# ══════════════════════════════════════════════════════════════════════════════

def fetch_heatmap(
    symbol:   str = "Binance_BTCUSDT",
    interval: int = 5,
    limit:    int = 288,
    retries:  int = 3,
) -> dict | None:
    """
    Fetch and decrypt the liquidation heatmap.

    Interval × Limit reference:
      interval=5,    limit=288  → 24h  (5min candles)
      interval=15,   limit=288  → 3d
      interval=60,   limit=168  → 7d
      interval=240,  limit=90   → 15d
      interval=1440, limit=30   → 30d
    """
    for attempt in range(1, retries + 1):
        try:
            data_param   = _generate_data_param()
            cache_ts_v2  = str(int(time.time() * 1000))  # ← record NOW, used in decryption
            headers      = _build_headers(cache_ts_v2)
            params       = {
                "merge":    "true",
                "symbol":   symbol,
                "interval": interval,
                "limit":    limit,
                "data":     data_param,
            }

            log.info(f"[Attempt {attempt}] {symbol} | {interval}min × {limit}")

            r = requests.get(
                _BASE_URL + "/api/index/v2/liqHeatMap",
                headers=headers,
                params=params,
                timeout=20,
            )

            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()

            body = r.json()
            is_encrypted = r.headers.get("encryption", "").lower() == "true"
            user_header  = r.headers.get("user", "")
            v_header     = r.headers.get("v", "0")
            time_header  = r.headers.get("time", "")

            if not is_encrypted:
                log.info("  Response is unencrypted.")
                return body

            encrypted_data = body.get("data", "")
            if not isinstance(encrypted_data, str):
                log.info("  data field is not a string — already decrypted.")
                return body

            log.info("  Decrypting...")
            result = decrypt_response(
                encrypted_data, user_header, cache_ts_v2, v_header,
                endpoint="/api/index/v2/liqHeatMap",
                time_header=time_header,
            )

            if result:
                log.info("  ✅ Decrypted successfully.")
                return {"code": body.get("code"), "msg": body.get("msg"), "data": result}

            # Save debug info if decryption fails
            ts = int(time.time())
            debug_path = OUTPUT_DIR / f"debug_raw_{ts}.json"
            all_headers = dict(r.headers)
            with open(debug_path, "w") as f:
                json.dump({
                    "raw_wrapper": body,
                    "user_header": user_header,
                    "v_header":    v_header,
                    "data_param":  data_param,
                    "cache_ts_v2": cache_ts_v2,
                    "all_response_headers": all_headers,
                }, f, indent=2)
            log.error(f"  Decryption failed. v_header={v_header!r}. Debug saved → {debug_path}")
            log.error(f"  Response headers: { {k:v for k,v in all_headers.items() if k.lower() in ('v','user','encryption','content-type','x-request-id','x-trace-id')} }")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def _handle_response(r, cache_ts_v2, endpoint):
    r.raise_for_status()
    body        = r.json()
    user_header = r.headers.get("user", "")
    v_header    = r.headers.get("v", "0")
    time_header = r.headers.get("time", "")
    is_enc      = r.headers.get("encryption", "").lower() == "true"

    if not is_enc or not isinstance(body.get("data"), str):
        return body

    result = decrypt_response(body["data"], user_header, cache_ts_v2, v_header, endpoint, time_header)
    if result is None:
        log.error(f"  v_header={v_header!r} — unhandled scheme. Headers: { {k:v for k,v in r.headers.items() if k.lower() in ('v','user','encryption','time')} }")
    return result


def fetch_oi_expiry(symbol="BTC", ex="Deribit", type="Delivery", subtype="ALL", currency="USD", retries=3):
    endpoint = "/api/option/v2/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "ex": ex, "type": type, "subtype": subtype, "currency": currency}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {type}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_options_oi(symbol="BTC", timeType=0, currency="USD", retries=3):
    endpoint = "/api/option/oi/history"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "timeType": timeType, "currency": currency}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_options_vs_futures(retries=3):
    endpoint = "/api/index/optionVsFuturesByOi"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)

            log.info(f"[Attempt {attempt}] {endpoint}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_options_greeks(symbol="BTC", ex="Deribit", time_param="", retries=3):
    endpoint = "/api/option/index/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "ex": ex, "time": time_param}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {ex}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_max_pain(symbol="BTC", ex="Deribit", retries=3):
    endpoint = "/api/option/strike_pain"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "ex": ex}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {ex}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_option_delivery_volume(symbol="BTC", ex="Deribit", subtype="ALL", currency="USD", retries=3):
    endpoint = "/api/option/v2/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "ex": ex,
                "type": "Delivery",
                "subtype": subtype,
                "currency": currency,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} Delivery")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_liq_heatmap_binance(symbol="Binance_BTCUSDT", interval=5, limit=288, retries=3):
    endpoint = "/api/index/v2/liqHeatMap"
    for attempt in range(1, retries + 1):
        try:
            data_param = _generate_data_param()
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "merge": "true",
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
                "data": data_param,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {interval}min")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_liq_map_exchange(symbol="BTC", interval=1, limit=1500, retries=3):
    endpoint = "/api/index/2/exLiqMap"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "merge": "true",
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {interval}min")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_liq_count_heatmap(type_param="openInterest", time_param="30d", retries=3):
    endpoint = "/api/futures/liquidation/count/heatmap"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "type": type_param,
                "time": time_param,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {type_param} {time_param}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_hyperliquid_liq_map(symbol="BTC", retries=3):
    endpoint = "/api/hyperliquid/topPosition/liqMap"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_hyperliquid_trader_ratio(interval="day", coin="all", retries=3):
    endpoint = "/api/hyperliquid/position/user/count"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "interval": interval,
                "coin": coin,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {interval} {coin}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_oi_statistics(symbol="BTC", retries=3):
    endpoint = "/api/openInterest/statistics"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_oi_statistics_altcoin(filter="BTC,ETH", retries=3):
    endpoint = "/api/openInterest/statistics"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"filter": filter}

            log.info(f"[Attempt {attempt}] {endpoint} | altcoin filter={filter}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_oi_chart_v3(symbol="BTC", timeType=0, exchangeName="", currency="USD", type=0, retries=3):
    endpoint = "/api/openInterest/v3/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "timeType": timeType,
                "exchangeName": exchangeName,
                "currency": currency,
                "type": type,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_oi_info(symbol="BTC", retries=3):
    endpoint = "/api/openInterest/info"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_volume_chart(symbol="", type=0, timeType=0, retries=3):
    endpoint = "/api/futures/vol/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "type": type,
                "timeType": timeType,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | type={type} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_orderbook_liquidity(symbol="Binance_BTCUSDT#1#hundredth_depth", interval="15m", minLimit=False, limit=300, retries=3):
    endpoint = "/api/v2/kline"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "interval": interval,
                "minLimit": str(minLimit).lower(),
                "limit": limit,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {interval}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_kline_premium_index(symbol="Binance_BTCUSDT#premium_index", interval="m1", minLimit=False, limit=300, retries=3):
    endpoint = "/api/kline"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "interval": interval,
                "minLimit": str(minLimit).lower(),
                "limit": limit,
            }

            log.info(f"[Attempt {attempt}] {endpoint} (Binance premium) | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_kline_coinbase_premium(symbol="Binance_BTCUSDT#coinbase_premium_index", interval="m30", limit=300, retries=3):
    endpoint = "/api/kline"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "interval": interval,
                "limit": limit,
            }

            log.info(f"[Attempt {attempt}] {endpoint} (Coinbase premium) | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_btc_dominance(retries=3):
    endpoint = "/api/escape/index/bitcoinDominance"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)

            log.info(f"[Attempt {attempt}] {endpoint}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_funding_rate_history(symbol="BTC", type_param="U", interval="h8", retries=3):
    endpoint = "/api/fundingRate/v2/history/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "type": type_param,
                "interval": interval,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} {interval}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_insurance_fund(ex="Binance", symbol="BTCUSDT", retries=3):
    endpoint = "/api/futures/insuranceFundBalance/history"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "ex": ex,
                "symbol": symbol,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {ex} {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_kline_margin_rate(symbol="Binance_USDT#margin", interval="h1", minLimit=False, limit=300, retries=3):
    endpoint = "/api/kline"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "interval": interval,
                "minLimit": str(minLimit).lower(),
                "limit": limit,
            }

            log.info(f"[Attempt {attempt}] {endpoint} (Binance margin) | {symbol}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_current_price(symbol: str = "BTCUSDT") -> float | None:
    """Fetch current spot price from Binance public REST API (no auth needed)."""
    try:
        r = requests.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": symbol},
            timeout=5,
        )
        r.raise_for_status()
        price = float(r.json()["price"])
        log.info(f"  Current {symbol} price: ${price:,.2f}")
        return price
    except Exception as e:
        log.warning(f"  Could not fetch price from Binance public API: {e}")
        return None


def fetch_liquidation_events(slug="pro-futures-liquidation-events", lang="en", retries=3):
    endpoint = "/api/strapi/page"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "slug": slug,
                "lang": lang,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {slug}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            body = r.json()
            log.info("  ✅ Fetched successfully.")
            return body

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_bitmex_funding_rate(slug="pro-futures-BitmexFundingRate", lang="en", retries=3):
    endpoint = "/api/strapi/page"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "slug": slug,
                "lang": lang,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {slug}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            body = r.json()
            log.info("  ✅ Fetched successfully.")
            return body

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_liquidation_chart(symbol="BTC", timeType=0, exchangeName="", currency="USD", retries=3):
    """Long vs short liquidation volumes by timeframe across all exchanges."""
    endpoint = "/api/futures/liquidation/chart"   # was /v2/chart before 2026-06 redeploy
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "timeType": timeType,
                "exchangeName": exchangeName,
                "currency": currency,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_long_short_ratio(symbol="BTC", timeType=1, retries=3):
    """Long/short position ratio chart — longRateList, shortsRateList, longShortRateList."""
    endpoint = "/api/futures/longShortChart"   # was longShortRatio/chart before 2026-06 redeploy
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "timeType": timeType,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_taker_buy_sell(symbol="BTC", timeType=0, exchangeName="", currency="USD", retries=3):
    """
    Taker buy/sell volumes — now sourced from liquidation/chart (buyVolUsd/sellVolUsd).
    buyVolUsd  = shorts liquidated (market buys to close short positions)
    sellVolUsd = longs  liquidated (market sells to close long positions)
    The old /api/futures/taker/chart endpoint was removed in the 2026-06 CoinGlass redeploy.
    """
    endpoint = "/api/futures/liquidation/chart"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {
                "symbol": symbol,
                "timeType": timeType,
                "exchangeName": exchangeName,
                "currency": currency,
            }

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} timeType={timeType}")

            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired. Recapture from DevTools.")
                return None
            if r.status_code == 403:
                log.error("❌ 403 Forbidden.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None

        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)

    return None


def fetch_liquidation_today(symbol="BTC", retries=3):
    """
    Today's actual liquidation snapshot.
    Returns: longLiquidationUsd, shortLiquidationUsd, liquidationUsd,
             longLiquidationRate, shortLiquidationRate, liquidationTraders,
             maxLiquidationVolUsd, exList (by exchange), avg7dRate.
    """
    endpoint = "/api/futures/liquidation/today"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "timeType": 0}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol}")
            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired.")
                return None
            if r.status_code in (403, 404):
                return None
            if r.status_code == 429:
                time.sleep(30 * (2 ** (attempt - 1)) + random.uniform(0, 10))
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None
        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)
    return None


def fetch_long_short_rate(symbol="BTC", timeType=0, exchangeName="Binance", retries=3):
    """
    Current long/short rate snapshot per exchange.
    Returns list of exchange dicts with longRate, shortRate, longVolUsd, shortVolUsd.
    """
    endpoint = "/api/futures/longShortRate"
    for attempt in range(1, retries + 1):
        try:
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            params = {"symbol": symbol, "timeType": timeType, "exchangeName": exchangeName}

            log.info(f"[Attempt {attempt}] {endpoint} | {symbol} exchange={exchangeName}")
            r = requests.get(_BASE_URL + endpoint, headers=headers, params=params, timeout=20)
            log.info(f"  Status: {r.status_code} | v={r.headers.get('v','?')} | enc={r.headers.get('encryption','?')}")

            if r.status_code == 401:
                log.error("❌ 401 — obe token expired.")
                return None
            if r.status_code in (403, 404):
                return None
            if r.status_code == 429:
                time.sleep(30 * (2 ** (attempt - 1)) + random.uniform(0, 10))
                continue

            r.raise_for_status()
            result = _handle_response(r, cache_ts_v2, endpoint)
            if result:
                log.info("  ✅ Decrypted successfully.")
                return result
            log.error("  Decryption failed.")
            return None
        except requests.exceptions.RequestException as e:
            log.error(f"  Request error: {e}")
            time.sleep(attempt * 3)
    return None


def fetch_etf_flows(retries=3) -> dict | None:
    """
    Scrape Bitcoin ETF daily net flows from farside.co.uk.
    Returns dict with keys: headers, rows (list of dicts), last_30d_totals.
    No CoinGlass auth needed — plain HTTP GET.
    """
    url = "https://farside.co.uk/bitcoin-etf-flow-all-data/"
    import re as _re

    for attempt in range(1, retries + 1):
        try:
            log.info(f"[Attempt {attempt}] ETF flows → {url}")
            r = requests.get(
                url,
                headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Accept": "text/html",
                },
                timeout=20,
            )
            r.raise_for_status()
            html = r.text

            # Find all tables and pick the one with the most columns (data table)
            all_tables = _re.findall(r'<table[^>]*>(.*?)</table>', html, _re.DOTALL | _re.IGNORECASE)
            if not all_tables:
                log.error("  ETF flows: no <table> found in page")
                return None

            def _count_cols(t):
                ths = _re.findall(r'<th[^>]*>(.*?)</th>', t, _re.DOTALL | _re.IGNORECASE)
                tds = _re.findall(r'<td[^>]*>(.*?)</td>', (_re.findall(r'<tr[^>]*>(.*?)</tr>', t, _re.DOTALL | _re.IGNORECASE) or [''])[0], _re.DOTALL | _re.IGNORECASE)
                return max(len(ths), len(tds))

            table_html = max(all_tables, key=_count_cols)

            # Parse header — try <thead><th>, then first <tr><th>, then first <tr><td>
            headers = []
            thead_m = _re.search(r'<thead[^>]*>(.*?)</thead>', table_html, _re.DOTALL | _re.IGNORECASE)
            if thead_m:
                th_cells = _re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', thead_m.group(1), _re.DOTALL | _re.IGNORECASE)
                headers = [_re.sub(r'<[^>]+>', '', c).strip() for c in th_cells]
            if not headers:
                first_tr = (_re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, _re.DOTALL | _re.IGNORECASE) or [''])[0]
                th_cells = _re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', first_tr, _re.DOTALL | _re.IGNORECASE)
                headers = [_re.sub(r'<[^>]+>', '', c).strip() for c in th_cells]

            # Parse data rows — skip first row if it's the header
            body_m = _re.search(r'<tbody[^>]*>(.*?)</tbody>', table_html, _re.DOTALL | _re.IGNORECASE)
            rows_html = body_m.group(1) if body_m else table_html
            tr_blocks = _re.findall(r'<tr[^>]*>(.*?)</tr>', rows_html, _re.DOTALL | _re.IGNORECASE)

            rows = []
            for tr in tr_blocks:
                td_cells = _re.findall(r'<td[^>]*>(.*?)</td>', tr, _re.DOTALL | _re.IGNORECASE)
                if not td_cells:
                    continue
                vals = [_re.sub(r'<[^>]+>', '', c).strip() for c in td_cells]
                if not any(vals):
                    continue
                if headers and len(vals) == len(headers):
                    rows.append(dict(zip(headers, vals)))
                elif vals:
                    rows.append({"_cols": vals})

            # Build 30-day totals per ETF ticker
            def _to_float(s):
                s = s.replace(',', '').strip()
                try:
                    return float(s)
                except (ValueError, TypeError):
                    return 0.0

            last_30 = rows[-30:] if len(rows) >= 30 else rows
            totals_30d: dict[str, float] = {}
            if headers and last_30:
                for row in last_30:
                    for col in headers[1:]:  # skip Date col
                        if col and col != "Total":
                            totals_30d[col] = totals_30d.get(col, 0.0) + _to_float(row.get(col, "0"))

            log.info(f"  ✅ ETF flows: {len(rows)} days, {len(headers)} tickers")
            return {
                "headers": headers,
                "rows": rows,
                "last_30d_totals_m": {k: round(v, 2) for k, v in totals_30d.items()},
                "fetched_at": int(time.time()),
            }

        except requests.exceptions.RequestException as e:
            log.error(f"  ETF flows request error: {e}")
            time.sleep(attempt * 3)

    return None


# ══════════════════════════════════════════════════════════════════════════════
#  PARSER
# ══════════════════════════════════════════════════════════════════════════════

def parse_heatmap(raw: dict) -> list[dict] | None:
    inner = raw.get("data", raw)
    if isinstance(inner, dict) and "data" in inner:
        inner = inner["data"]

    price_list = inner.get("y") or inner.get("priceList") or []
    time_list  = inner.get("x") or inner.get("timeList")  or []
    matrix     = inner.get("data") or inner.get("dataMap") or []

    if not price_list or not time_list or not matrix:
        log.warning(f"Unexpected structure. Keys: {list(inner.keys())}")
        return None

    log.info(f"  {len(price_list)} price levels × {len(time_list)} time points")

    records = []
    if isinstance(matrix, list):
        for pi, row in enumerate(matrix):
            if pi >= len(price_list) or not isinstance(row, list):
                continue
            price = price_list[pi]
            for ti, vol in enumerate(row):
                if vol and vol > 0 and ti < len(time_list):
                    ts = time_list[ti]
                    records.append({
                        "price":    price,
                        "timestamp":ts,
                        "datetime": datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                        "volume":   vol,
                    })
    elif isinstance(matrix, dict):
        for price_str, volumes in matrix.items():
            price = float(price_str)
            for i, vol in enumerate(volumes):
                if vol and vol > 0 and i < len(time_list):
                    ts = time_list[i]
                    records.append({
                        "price":    price,
                        "timestamp":ts,
                        "datetime": datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
                        "volume":   vol,
                    })
    return records


# ══════════════════════════════════════════════════════════════════════════════
#  COINGLASS ON-CHAIN METRICS  (SOPR, NUPL, MVRV, LTH/STH, Whales, Cohorts)
# ══════════════════════════════════════════════════════════════════════════════

_FAPI_URL = "https://fapi.coinglass.com"


def _fetch_cg(path: str, base_url: str | None = None, params: dict | None = None, retries: int = 2) -> dict | None:
    """Generic CoinGlass fetch + decrypt for capi or fapi endpoints."""
    url_base = base_url or _BASE_URL
    for attempt in range(1, retries + 1):
        try:
            global_limiter.wait()
            cache_ts_v2 = str(int(time.time() * 1000))
            headers = _build_headers(cache_ts_v2)
            r = requests.get(url_base + path, headers=headers, params=params or {}, timeout=20)
            log.info(f"  {path} → {r.status_code} v={r.headers.get('v','?')}")
            if r.status_code == 401:
                log.error("❌ 401 — obe token expired.")
                return None
            if r.status_code == 429:
                wait_time = 30 * (2 ** (attempt - 1)) + random.uniform(0, 10)
                log.warning(f"⚠️  Rate limited. Waiting {wait_time:.1f}s...")
                time.sleep(wait_time)
                continue
            r.raise_for_status()
            body = r.json()
            is_enc = r.headers.get("encryption", "").lower() == "true"
            if not is_enc or not isinstance(body.get("data"), str):
                return body
            result = decrypt_response(
                body["data"], r.headers.get("user", ""),
                cache_ts_v2, r.headers.get("v", "0"), path, r.headers.get("time", "")
            )
            if result is not None:
                return {"code": body.get("code"), "msg": body.get("msg"), "data": result}
            log.error(f"  Decryption failed for {path}")
            return None
        except requests.exceptions.RequestException as e:
            log.error(f"  {path} attempt {attempt}: {e}")
            if attempt < retries:
                time.sleep(attempt * 3)
    return None


def _extract_latest(data, value_keys=("value", "v", "y", "sopr", "nupl", "mvrv"),
                    primary_key: str | None = None) -> float | None:
    """
    Extract the most recent scalar from a CoinGlass time-series response.
    primary_key: if set, checked first in list-of-dict items.
    """
    if data is None:
        return None
    if isinstance(data, (int, float)):
        return float(data)
    search_keys = ((primary_key,) if primary_key else ()) + tuple(value_keys)
    if isinstance(data, list) and data:
        last = data[-1]
        if isinstance(last, (int, float)):
            return float(last)
        if isinstance(last, dict):
            for k in search_keys:
                if k and last.get(k) is not None:
                    try:
                        return float(last[k])
                    except (ValueError, TypeError):
                        pass
    if isinstance(data, dict):
        for list_key in ("valueList", "priceList", "dataList", "soprList", "nuplList"):
            vlist = data.get(list_key)
            if vlist and isinstance(vlist, list) and vlist[-1] is not None:
                try:
                    return float(vlist[-1])
                except (ValueError, TypeError):
                    pass
        for k in search_keys + ("currentValue", "lastValue"):
            if k and data.get(k) is not None:
                try:
                    return float(data[k])
                except (ValueError, TypeError):
                    pass
        if "list" in data and isinstance(data["list"], list) and data["list"]:
            return _extract_latest(data["list"], value_keys, primary_key)
    return None


def _extract_series_last2(data, primary_key: str | None = None) -> tuple[float | None, float | None]:
    """Return (prev, last) scalars from a time-series for trend computation."""
    series = None
    if isinstance(data, list):
        series = data
    elif isinstance(data, dict):
        for k in ("valueList", "dataList", "priceList"):
            if k in data and isinstance(data[k], list):
                series = data[k]
                break
    if series and len(series) >= 2:
        def _val(item):
            if isinstance(item, (int, float)):
                return float(item)
            if isinstance(item, dict):
                for k in ((primary_key,) if primary_key else ()) + ("value", "v", "num"):
                    if k and item.get(k) is not None:
                        try:
                            return float(item[k])
                        except (ValueError, TypeError):
                            pass
            return None
        prev = _val(series[-2])
        last = _val(series[-1])
        return prev, last
    return None, None


def fetch_nupl_cg() -> dict:
    """NUPL from capi.coinglass.com/api/escape/index/nupl. Items: {index=NUPL_value, price=BTC_price, timestamp}"""
    raw = _fetch_cg("/api/escape/index/nupl", base_url=_BASE_URL)
    result = {"nupl": "N/A", "nupl_label": "N/A"}
    if not raw:
        return result
    val = _extract_latest(raw.get("data"), primary_key="index")
    if val is not None:
        result["nupl"] = round(val, 4)
        if val > 0.75:    result["nupl_label"] = "Euphoria"
        elif val > 0.5:   result["nupl_label"] = "Belief"
        elif val > 0.25:  result["nupl_label"] = "Optimism"
        elif val >= 0:    result["nupl_label"] = "Hope/Fear"
        else:             result["nupl_label"] = "Capitulation"
    return result


def fetch_mvrv_cg() -> dict:
    """MVRV from capi.coinglass.com/api/escape/index/mVRVRatio. Items: {index=MVRV_ratio, price=BTC_price, timestamp}"""
    raw = _fetch_cg("/api/escape/index/mVRVRatio", base_url=_BASE_URL)
    result = {"mvrv": "N/A", "mvrv_signal": "N/A"}
    if not raw:
        return result
    val = _extract_latest(raw.get("data"), primary_key="index")
    if val is not None:
        result["mvrv"] = round(val, 3)
        if val > 3.5:   result["mvrv_signal"] = "Overvalued"
        elif val > 1.0: result["mvrv_signal"] = "Fair Value"
        else:           result["mvrv_signal"] = "Undervalued"
    return result


def fetch_sopr_cg() -> dict:
    """SOPR from fapi.coinglass.com/api/metrics/bitcoinSOPR"""
    raw = _fetch_cg("/api/metrics/bitcoinSOPR", base_url=_FAPI_URL)
    result = {"sopr": "N/A", "sopr_signal": "N/A"}
    if not raw:
        return result
    val = _extract_latest(raw.get("data"))
    if val is not None:
        result["sopr"] = round(val, 4)
        if val > 1.02:    result["sopr_signal"] = "Bullish"
        elif val >= 0.98: result["sopr_signal"] = "Neutral"
        else:             result["sopr_signal"] = "Bearish"
    return result


def fetch_lth_sth_price_cg() -> dict:
    """LTH and STH Realized Prices from fapi endpoints."""
    lth_raw = _fetch_cg("/api/metrics/bitcoinLTHRealizedPrice", base_url=_FAPI_URL)
    global_limiter.wait()
    sth_raw = _fetch_cg("/api/metrics/bitcoinSTHRealizedPrice", base_url=_FAPI_URL)
    result = {"lth_price": "N/A", "sth_price": "N/A",
              "lth_distance_pct": "N/A", "sth_distance_pct": "N/A"}
    lth_val = _extract_latest(lth_raw.get("data") if lth_raw else None)
    sth_val = _extract_latest(sth_raw.get("data") if sth_raw else None)
    if lth_val is not None:
        result["lth_price"] = round(lth_val, 0)
    if sth_val is not None:
        result["sth_price"] = round(sth_val, 0)
    return result


def fetch_whale_addresses_cg() -> dict:
    """Addresses holding >1000 BTC. Response items: {num, price, timestamp}"""
    raw = _fetch_cg("/api/metrics/balanceGt1k", base_url=_FAPI_URL)
    result = {"whale_addr_count": "N/A", "whale_addr_trend": "N/A"}
    if not raw:
        return result
    prev, last = _extract_series_last2(raw.get("data"), primary_key="num")
    if last is not None:
        result["whale_addr_count"] = int(last)
    if prev is not None and last is not None:
        delta = last - prev
        result["whale_addr_trend"] = "Accumulating" if delta > 0 else ("Distributing" if delta < 0 else "Flat")
    return result


def fetch_address_cohorts_cg() -> dict:
    """Address balance cohorts from fapi endpoints (>0.1 to >1000 BTC). Items: {num, price, timestamp}"""
    tiers = {
        "gt1k":  "/api/metrics/balanceGt1k",
        "gt100": "/api/metrics/balanceGt100",
        "gt10":  "/api/metrics/balanceGt10",
        "gt1":   "/api/metrics/balanceGt1",
        "gt0p1": "/api/metrics/balanceGt0P1",
    }
    result = {}
    for key, path in tiers.items():
        global_limiter.wait()
        raw = _fetch_cg(path, base_url=_FAPI_URL)
        val = _extract_latest(raw.get("data") if raw else None, primary_key="num")
        result[f"addr_{key}"] = int(val) if val is not None else "N/A"
    return result


def fetch_all_onchain_coinglass() -> dict:
    """
    Fetch all CoinGlass on-chain metrics in one call.
    Returns combined dict consumed by onchain_fetcher.fetch_all_onchain().
    """
    log.info("── CoinGlass On-Chain: NUPL...")
    out = {}
    out.update(fetch_nupl_cg())
    log.info("── CoinGlass On-Chain: MVRV...")
    out.update(fetch_mvrv_cg())
    log.info("── CoinGlass On-Chain: SOPR...")
    out.update(fetch_sopr_cg())
    log.info("── CoinGlass On-Chain: LTH/STH Price...")
    out.update(fetch_lth_sth_price_cg())
    log.info("── CoinGlass On-Chain: Whale Addresses...")
    out.update(fetch_whale_addresses_cg())
    log.info("── CoinGlass On-Chain: Address Cohorts...")
    out.update(fetch_address_cohorts_cg())
    fetched = sum(1 for v in out.values() if v != "N/A")
    log.info(f"  ✅ CoinGlass on-chain: {fetched}/{len(out)} metrics")
    return out


def save_json(data, name):
    p = OUTPUT_DIR / name
    with open(p, "w") as f:
        json.dump(data, f, indent=2)
    log.info(f"💾 {p}")

def save_csv(records, name):
    if not records: return
    p = OUTPUT_DIR / name
    keys = list(records[0].keys())
    with open(p, "w") as f:
        f.write(",".join(keys) + "\n")
        for row in records:
            f.write(",".join(str(row.get(k,"")) for k in keys) + "\n")
    log.info(f"💾 {p}")


# ══════════════════════════════════════════════════════════════════════════════
#  MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    log.info("=" * 60)
    log.info("  CoinGlass Heatmap Scraper — Fully Decoded")
    log.info("=" * 60)

    if "PASTE" in OBE:
        log.error("❌ Set your OBE token at the top of this file.")
        log.error("   DevTools → Network → liqHeatMap → Request Headers → obe")
        exit(1)

    check_js_bundle()

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    OUTPUT_DIR = Path("output") / ts
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    log.info(f"📁 Saving to output/{ts}/")

    # Bundle collects raw payloads for the metrics layer at the end.
    bundle: dict = {
        "current_price":        None,
        "heatmap_24h_raw":      None,
        "heatmap_3d_raw":       None,
        "heatmap_7d_raw":       None,
        "funding_raw":          None,
        "oi_chart_raw":         None,
        "oi_info_raw":          None,
        "coinbase_premium_raw": None,
        "liq_today_raw":         None,   # today's actual long/short liq snapshot
        "liq_chart_raw":         None,   # long vs short liq volumes by TF
        "long_short_ratio_raw":  None,   # L/S ratio chart (longRateList, etc.)
        "long_short_rate_raw":   None,   # L/S rate per-exchange snapshot
        "taker_buy_sell_raw":    None,   # buyVolUsd/sellVolUsd from liq/chart
        "etf_flows_raw":         None,   # farside.co.uk ETF flows
    }

    # ── Heatmap 24h ──────────────────────────────────────────────────────────
    raw = fetch_heatmap("Binance_BTCUSDT", interval=5, limit=288)
    if raw:
        save_json(raw, f"raw_BTC_{ts}.json")
        bundle["heatmap_24h_raw"] = raw
        records = parse_heatmap(raw)
        if records:
            save_csv(records, f"BTC_heatmap_{ts}.csv")
            prices  = [r["price"]  for r in records]
            volumes = [r["volume"] for r in records]
            log.info(f"\n📈 Price range : ${min(prices):,.0f} – ${max(prices):,.0f}")
            log.info(f"   Total volume: {sum(volumes):,.2f}")
            log.info(f"   Peak volume : {max(volumes):,.2f}")
            log.info(f"   Records     : {len(records)}")
        log.info("\n✅ Done. Check output/")
    else:
        log.error("\n❌ Failed — check output/ for debug_raw_*.json")

    # ── Heatmap 3d ───────────────────────────────────────────────────────────
    log.info("\n── Heatmap 3d (15m×288) ──")
    global_limiter.wait()
    raw3d = fetch_heatmap("Binance_BTCUSDT", interval=15, limit=288)
    if raw3d:
        save_json(raw3d, f"heatmap_3d_{ts}.json")
        bundle["heatmap_3d_raw"] = raw3d

    # ── Heatmap 7d ───────────────────────────────────────────────────────────
    log.info("\n── Heatmap 7d (60m×168) ──")
    global_limiter.wait()
    raw7d = fetch_heatmap("Binance_BTCUSDT", interval=60, limit=168)
    if raw7d:
        save_json(raw7d, f"heatmap_7d_{ts}.json")
        bundle["heatmap_7d_raw"] = raw7d

    log.info("\n── OI Expiry ──")
    global_limiter.wait()
    data = fetch_oi_expiry()
    if data: save_json(data, f"oi_expiry_{ts}.json")

    log.info("\n── Options OI ──")
    global_limiter.wait()
    data = fetch_options_oi()
    if data: save_json(data, f"options_oi_{ts}.json")

    log.info("\n── Options vs Futures ──")
    global_limiter.wait()
    data = fetch_options_vs_futures()
    if data: save_json(data, f"options_vs_futures_{ts}.json")

    log.info("\n── Options Greeks ──")
    global_limiter.wait()
    data = fetch_options_greeks()
    if data: save_json(data, f"options_greeks_{ts}.json")

    log.info("\n── Max Pain ──")
    global_limiter.wait()
    data = fetch_max_pain()
    if data: save_json(data, f"max_pain_{ts}.json")

    log.info("\n── Option Delivery Volume ──")
    global_limiter.wait()
    data = fetch_option_delivery_volume()
    if data: save_json(data, f"delivery_volume_{ts}.json")

    log.info("\n── Liquidation Heatmap (Binance) ──")
    global_limiter.wait()
    data = fetch_liq_heatmap_binance()
    if data: save_json(data, f"liq_heatmap_binance_{ts}.json")

    log.info("\n── Liquidation Map (Exchange) ──")
    global_limiter.wait()
    data = fetch_liq_map_exchange()
    if data: save_json(data, f"liq_map_exchange_{ts}.json")

    log.info("\n── Liquidation Count Heatmap ──")
    global_limiter.wait()
    data = fetch_liq_count_heatmap()
    if data: save_json(data, f"liq_count_heatmap_{ts}.json")

    log.info("\n── Hyperliquid Liquidation Map ──")
    global_limiter.wait()
    data = fetch_hyperliquid_liq_map()
    if data: save_json(data, f"hyperliq_liqmap_{ts}.json")

    log.info("\n── Hyperliquid Trader Ratio ──")
    global_limiter.wait()
    data = fetch_hyperliquid_trader_ratio()
    if data: save_json(data, f"hyperliq_ratio_{ts}.json")

    log.info("\n── OI Statistics ──")
    global_limiter.wait()
    data = fetch_oi_statistics()
    if data: save_json(data, f"oi_stats_{ts}.json")

    log.info("\n── OI Statistics (Altcoin) ──")
    global_limiter.wait()
    data = fetch_oi_statistics_altcoin()
    if data: save_json(data, f"oi_stats_altcoin_{ts}.json")

    log.info("\n── OI Chart v3 ──")
    global_limiter.wait()
    data = fetch_oi_chart_v3()
    if data:
        save_json(data, f"oi_chart_v3_{ts}.json")
        bundle["oi_chart_raw"] = data

    log.info("\n── OI Info ──")
    global_limiter.wait()
    data = fetch_oi_info()
    if data:
        save_json(data, f"oi_info_{ts}.json")
        bundle["oi_info_raw"] = data

    log.info("\n── Volume Chart ──")
    global_limiter.wait()
    data = fetch_volume_chart()
    if data: save_json(data, f"vol_chart_{ts}.json")

    log.info("\n── Orderbook Liquidity ──")
    global_limiter.wait()
    data = fetch_orderbook_liquidity()
    if data: save_json(data, f"orderbook_liquidity_{ts}.json")

    log.info("\n── Kline Premium Index (Binance) ──")
    global_limiter.wait()
    data = fetch_kline_premium_index()
    if data: save_json(data, f"premium_index_{ts}.json")

    log.info("\n── Kline Coinbase Premium ──")
    global_limiter.wait()
    data = fetch_kline_coinbase_premium()
    if data:
        save_json(data, f"coinbase_premium_{ts}.json")
        bundle["coinbase_premium_raw"] = data

    log.info("\n── BTC Dominance ──")
    global_limiter.wait()
    data = fetch_btc_dominance()
    if data: save_json(data, f"btc_dominance_{ts}.json")

    log.info("\n── Funding Rate History ──")
    global_limiter.wait()
    data = fetch_funding_rate_history()
    if data:
        save_json(data, f"funding_rate_history_{ts}.json")
        bundle["funding_raw"] = data

    log.info("\n── Insurance Fund ──")
    global_limiter.wait()
    data = fetch_insurance_fund()
    if data: save_json(data, f"insurance_fund_{ts}.json")

    log.info("\n── Kline Margin Rate (Binance) ──")
    global_limiter.wait()
    data = fetch_kline_margin_rate()
    if data: save_json(data, f"margin_rate_{ts}.json")

    log.info("\n── Liquidation Events (Strapi) ──")
    global_limiter.wait()
    data = fetch_liquidation_events()
    if data: save_json(data, f"liquidation_events_{ts}.json")

    log.info("\n── BitMEX Funding Rate (Strapi) ──")
    global_limiter.wait()
    data = fetch_bitmex_funding_rate()
    if data: save_json(data, f"bitmex_funding_rate_{ts}.json")

    log.info("\n── Liquidation Today (actual long/short volumes) ──")
    global_limiter.wait()
    data = fetch_liquidation_today()
    if data:
        save_json(data, f"liq_today_{ts}.json")
        bundle["liq_today_raw"] = data

    log.info("\n── Liquidation Chart (Long vs Short by TF) ──")
    global_limiter.wait()
    data = fetch_liquidation_chart()
    if data:
        save_json(data, f"liq_chart_{ts}.json")
        bundle["liq_chart_raw"] = data

    log.info("\n── Long/Short Ratio (chart) ──")
    global_limiter.wait()
    data = fetch_long_short_ratio()
    if data:
        save_json(data, f"long_short_ratio_{ts}.json")
        bundle["long_short_ratio_raw"] = data

    log.info("\n── Long/Short Rate (current snapshot) ──")
    global_limiter.wait()
    data = fetch_long_short_rate()
    if data:
        save_json(data, f"long_short_rate_{ts}.json")
        bundle["long_short_rate_raw"] = data

    log.info("\n── Taker/CVD (via liquidation/chart buyVol/sellVol) ──")
    global_limiter.wait()
    data = fetch_taker_buy_sell()
    if data:
        save_json(data, f"taker_buy_sell_{ts}.json")
        bundle["taker_buy_sell_raw"] = data

    log.info("\n── ETF Flows (farside.co.uk) ──")
    # No rate limit needed — different server, not CoinGlass
    data = fetch_etf_flows()
    if data:
        save_json(data, f"etf_flows_{ts}.json")
        bundle["etf_flows_raw"] = data

    # ── Current price ─────────────────────────────────────────────────────────
    log.info("\n── Current BTC Price ──")
    cp = fetch_current_price("BTCUSDT")
    if cp is None and bundle["heatmap_24h_raw"]:
        from metrics_builder import extract_current_price_from_heatmap
        cp = extract_current_price_from_heatmap(bundle["heatmap_24h_raw"])
        if cp:
            log.info(f"  Derived price from heatmap close: ${cp:,.2f}")
    bundle["current_price"] = cp

    # ── Metrics layer ─────────────────────────────────────────────────────────
    log.info("\n── Summary Metrics ──")
    try:
        from metrics_builder import build_summary_metrics, save_summary_metrics
        metric_rows = build_summary_metrics(bundle)
        if metric_rows:
            save_summary_metrics(metric_rows, OUTPUT_DIR, ts)
            log.info(f"  📊 {len(metric_rows)} metrics → summary_metrics_{ts}.csv / .json")
            sections = {}
            for r in metric_rows:
                sections[r["section"]] = sections.get(r["section"], 0) + 1
            for sec, cnt in sections.items():
                log.info(f"     {sec}: {cnt} rows")
        else:
            log.warning("  No metrics produced — check bundle contents")
    except Exception as exc:
        log.warning(f"  Metrics layer skipped: {exc}")

    # ── Output Dashboard ──────────────────────────────────────────────────────
    log.info("\n── Output Dashboard ──")
    try:
        from build_output_dashboard import build_output_dashboard
        build_output_dashboard(OUTPUT_DIR)
        log.info("📊 Refreshed output/index.html and output/dashboard_data.js")
    except Exception as exc:
        log.warning(f"Dashboard build skipped: {exc}")
