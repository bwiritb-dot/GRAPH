# Privacy Policy — CryptoDATEX Chrome Extension

Last updated: 20 September 2026

CryptoDATEX is a charting and technical-analysis tool for Binance USDT-M
futures and the PAXG/USDT gold-backed token. It runs entirely inside your
browser. There is no CryptoDATEX server, account or login.

## What the extension stores

All data below is created by you and stays on your device (Chrome's
`chrome.storage.local` and the extension's `localStorage`). It is never sent
to us or to anyone else. Uninstalling the extension deletes it.

- Chart settings: selected symbol, timeframe, active indicator tab.
- Price alerts you create (symbol, threshold, sound, enabled/disabled).
- Drawings you place on the chart (lines, boxes, long/short position boxes).
- Demo portfolios and paper-trading entries you record (hypothetical trades;
  no real funds, no exchange account).
- Position of the drawing toolbar.

## What the extension sends

The extension makes read-only requests for public market data to Binance:

- `https://fapi.binance.com` — candles, tickers and the exchange symbol list (REST).
- `wss://fstream.binance.com` — live candle and trade stream (WebSocket).

These requests contain only the market symbol and timeframe. No account
credentials, API keys, personal information or usage statistics are sent.
Binance may log the request as any web server does; see Binance's own
privacy policy for how it handles such logs.

## What we do not do

- We do not collect names, e-mail addresses, IP addresses, browsing history,
  keystrokes or any personally identifiable information.
- We do not ask for or store exchange API keys, wallet keys or seed phrases.
- We do not place trades. Paper trading is a local simulation only.
- We do not use analytics, advertising or tracking of any kind.
- We do not sell, share or transfer any data.

## Permissions

- `storage` — save the settings, alerts, drawings and paper trades listed above.
- `alarms` — check your price alerts once per minute in the background.
- `notifications` — show a desktop notification when one of your alerts triggers.
- Host permission `https://fapi.binance.com/*` — fetch public market data.

## Compliance

Use of information received from Google APIs adheres to the Chrome Web Store
User Data Policy, including the Limited Use requirements.

CryptoDATEX is an independent tool and is not affiliated with or endorsed by
Binance. It is an educational tool and does not provide financial advice.

## Changes

If this policy changes, the new version is published at the same address with
an updated date.

## Contact

cryptodatex@gmail.com
