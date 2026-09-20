# Privacy Policy for CryptoDATEX Chrome Extension

**Last Updated: August 2026**

CryptoDATEX ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy outlines how the CryptoDATEX Chrome Extension handles user data.

---

### 1. Single Purpose & Data Minimization
CryptoDATEX is a technical analysis and market data terminal designed to display real-time cryptocurrency futures and macroeconomic analytics directly within your browser.

### 2. Information We Collect (Zero Personal Data Collection)
- **No Personal Identification Information (PII):** We do not collect names, email addresses, phone numbers, IP addresses, browsing histories, or cryptographic private keys.
- **No Keystroke Tracking:** We do not record or monitor your keystrokes or inputs on third-party websites.
- **No Financial Data:** We do not connect directly to your trading account API secret keys, nor do we execute trades on your behalf.

### 3. Permissions Used & Purpose
- **`storage`**: Used exclusively to store your personal terminal preferences (theme choices, selected symbols, and custom alarm thresholds) locally on your device using `chrome.storage.local`.
- **`alarms`**: Used to schedule background intervals to evaluate price and indicator threshold alerts without consuming CPU cycles.
- **`notifications`**: Used exclusively to trigger native desktop notifications when user-configured price or volume conditions are met.

### 4. Third-Party Data Requests
The extension makes direct, read-only requests to publicly accessible cryptocurrency market endpoints:
- Public Binance Futures REST & WebSocket endpoints (`fapi.binance.com`) for market tickers, order book depth, and k-lines.
- Your local/hosted CryptoDATEX backend instance for custom indicator calculations (WTMO, MLMI/kNN, liquidation clusters).

No user data is ever sold, rented, or transferred to third-party data brokers or advertising networks.

### 5. Compliance with Chrome Web Store Policies
CryptoDATEX complies fully with the **Chrome Web Store User Data Policy**, including the Limited Use requirements.

### 6. Contact & Inquiries
For questions regarding this policy or technical inquiries, contact: `support@cryptodatex.com` or visit our repository documentation.
