/**
 * liquidations.js — BTC Liquidation Panel
 * Sources:
 *   REST: /api/liquidations  (via server.py → Binance /fapi/v1/forceOrders)
 *   WS:   wss://fstream.binance.com/ws/btcusdt@forceOrder
 */
'use strict';

(function () {

  const REFRESH_MS    = 30_000;   // REST refresh interval
  const MAX_FEED_ROWS = 60;       // max rows in live feed
  const USD_K         = 1_000;
  const USD_M         = 1_000_000;

  /* ── Helpers ─────────────────────────────────────────────────── */

  function fmtUsd(v) {
    if (v === null || v === undefined) return '—';
    v = Number(v);
    if (v >= USD_M)  return '$' + (v / USD_M).toFixed(2) + 'M';
    if (v >= USD_K)  return '$' + (v / USD_K).toFixed(1) + 'K';
    return '$' + v.toFixed(0);
  }

  function fmtTime(ts_s) {
    if (!ts_s) return '—';
    const d = new Date(ts_s * 1000);
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDate(ts_s) {
    if (!ts_s) return '—';
    const d = new Date(ts_s * 1000);
    return d.toLocaleString('ru-RU', { month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit' });
  }

  function el(id) { return document.getElementById(id); }

  /* ── Stats panel ─────────────────────────────────────────────── */

  function renderStats(data) {
    const longUsd  = data.long_total  || 0;
    const shortUsd = data.short_total || 0;
    const total    = longUsd + shortUsd;

    // Long liq (green) — these are SELL orders (long pos liq'd)
    const luEl = el('liq-long-usd');
    const lcEl = el('liq-long-cnt');
    if (luEl) { luEl.textContent = fmtUsd(longUsd);  luEl.className = 'liq-stat-val liq-val-red'; }
    if (lcEl)   lcEl.textContent = (data.long_count  || 0) + ' ордеров';

    // Short liq (red) — these are BUY orders (short pos liq'd)
    const suEl = el('liq-short-usd');
    const scEl = el('liq-short-cnt');
    if (suEl) { suEl.textContent = fmtUsd(shortUsd); suEl.className = 'liq-stat-val liq-val-green'; }
    if (scEl)   scEl.textContent = (data.short_count || 0) + ' ордеров';

    // Ratio bar
    const lsrEl   = el('liq-lsr');
    const fillL   = el('liq-fill-l');
    const fillS   = el('liq-fill-s');
    if (total > 0) {
      const pctL = (longUsd  / total * 100).toFixed(1);
      const pctS = (shortUsd / total * 100).toFixed(1);
      if (fillL)  fillL.style.width = pctL + '%';
      if (fillS)  fillS.style.width = pctS + '%';
      if (lsrEl) {
        const ratio = shortUsd > 0 ? (longUsd / shortUsd).toFixed(2) : '∞';
        lsrEl.textContent = `${pctL}% : ${pctS}%`;
        lsrEl.title       = `L/S ratio = ${ratio}`;
      }
    }

    // Timestamp
    const tsEl = el('liq-ts');
    if (tsEl && data.ts) tsEl.textContent = fmtTime(data.ts);
  }

  /* ── Hourly bar chart ─────────────────────────────────────────── */

  function renderBarChart(buckets) {
    const wrap = el('liq-bar-chart');
    if (!wrap || !buckets || !buckets.length) return;

    wrap.innerHTML = '';

    // Last 12 buckets
    const last = buckets.slice(-12);
    const maxVal = Math.max(...last.map(b => b.long_usd + b.short_usd), 1);

    last.forEach(b => {
      const total = b.long_usd + b.short_usd;
      const pctL  = total > 0 ? (b.long_usd  / maxVal * 100) : 0;
      const pctS  = total > 0 ? (b.short_usd / maxVal * 100) : 0;
      const h     = new Date(b.ts_ms).getHours().toString().padStart(2, '0');
      const m     = new Date(b.ts_ms).getMinutes().toString().padStart(2, '0');

      const col = document.createElement('div');
      col.className = 'liq-bar-col';
      col.title = `${h}:${m}\nLongs: ${fmtUsd(b.long_usd)} (${b.long_count})\nShorts: ${fmtUsd(b.short_usd)} (${b.short_count})`;

      col.innerHTML = `
        <div class="liq-bar-stacked">
          <div class="liq-bar-seg liq-bar-l" style="height:${pctL.toFixed(1)}%"></div>
          <div class="liq-bar-seg liq-bar-s" style="height:${pctS.toFixed(1)}%"></div>
        </div>
        <div class="liq-bar-lbl">${h}h</div>
      `;
      wrap.appendChild(col);
    });
  }

  /* ── Top 10 table ────────────────────────────────────────────── */

  function renderTop10(items) {
    const wrap = el('liq-top-list');
    if (!wrap || !items || !items.length) {
      if (wrap) wrap.innerHTML = '<div class="liq-loading">Нет данных</div>';
      return;
    }

    wrap.innerHTML = '';
    items.slice(0, 10).forEach(it => {
      const isLong  = it.side === 'SELL';  // long pos liquidated → SELL order
      const sideLabel = isLong ? 'LONG' : 'SHORT';
      const cls       = isLong ? 'liq-row-long' : 'liq-row-short';

      const row = document.createElement('div');
      row.className = `liq-top-row ${cls}`;
      row.innerHTML = `
        <span class="liq-row-side">${sideLabel}</span>
        <span class="liq-row-price">$${Number(it.price).toLocaleString('ru-RU')}</span>
        <span class="liq-row-qty">${it.qty} BTC</span>
        <span class="liq-row-usd">${fmtUsd(it.usd)}</span>
        <span class="liq-row-time">${fmtTime(it.time)}</span>
      `;
      wrap.appendChild(row);
    });
  }

  /* ── Live feed row ───────────────────────────────────────────── */

  function prependFeedRow(it) {
    const feed = el('liq-feed');
    if (!feed) return;

    const isLong    = it.side === 'SELL';
    const sideLabel = isLong ? '🔴 LONG' : '🟢 SHORT';
    const cls       = isLong ? 'liq-feed-long' : 'liq-feed-short';

    const row = document.createElement('div');
    row.className = `liq-feed-row ${cls} liq-feed-new`;
    row.innerHTML = `
      <span class="liq-feed-side">${sideLabel}</span>
      <span class="liq-feed-price">$${Number(it.price).toLocaleString('en-US')}</span>
      <span class="liq-feed-qty">${Number(it.qty).toFixed(3)} BTC</span>
      <span class="liq-feed-usd">${fmtUsd(it.usd)}</span>
      <span class="liq-feed-time">${fmtTime(it.time || Math.floor(Date.now()/1000))}</span>
    `;

    feed.prepend(row);
    setTimeout(() => row.classList.remove('liq-feed-new'), 600);

    // Trim old rows
    while (feed.children.length > MAX_FEED_ROWS) {
      feed.removeChild(feed.lastChild);
    }
  }

  /* ── REST fetch ──────────────────────────────────────────────── */

  async function fetchLiquidations() {
    try {
      const base = (typeof getAppBaseUrl === 'function') ? getAppBaseUrl() : '';
      const r    = await fetch(`${base}/api/liquidations?symbol=BTCUSDT&limit=200`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      renderStats(data);
      renderBarChart(data.buckets);
      renderTop10(data.top10 || data.items);
    } catch (e) {
      console.warn('[Liq] REST error:', e.message);
    }
  }

  /* ── WebSocket (Binance liquidation stream) ─────────────────── */

  let _ws      = null;
  let _wsRetry = 0;

  function setBadge(txt, ok) {
    const badge = el('liq-ws-badge');
    if (!badge) return;
    badge.textContent = txt;
    badge.className   = 'liq-ws-badge ' + (ok ? 'liq-ws-ok' : ok === false ? 'liq-ws-err' : 'liq-ws-warn');
  }

  function connectWs() {
    if (_ws && _ws.readyState <= 1) return;

    const url = 'wss://fstream.binance.com/ws/btcusdt@forceOrder';
    setBadge('WS: connecting…', null);

    try {
      _ws = new WebSocket(url);
    } catch(e) {
      setBadge('WS: err', false);
      return;
    }

    _ws.onopen = () => {
      _wsRetry = 0;
      setBadge('WS: live', true);
      console.log('[Liq] WebSocket connected');
    };

    _ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        // Binance forceOrder stream: { o: { s, S, p, q, T, ... } }
        const o   = msg.o || msg;
        const it  = {
          side:  o.S || o.side,
          price: parseFloat(o.p || o.averagePrice || o.price || 0),
          qty:   parseFloat(o.q || o.origQty || 0),
          usd:   parseFloat(o.p || 0) * parseFloat(o.q || 0),
          time:  Math.floor((o.T || o.time || Date.now()) / 1000),
        };
        if (it.price > 0 && it.qty > 0) {
          prependFeedRow(it);
        }
      } catch (e) {
        console.warn('[Liq] WS parse error:', e);
      }
    };

    _ws.onerror = () => setBadge('WS: error', false);

    _ws.onclose = () => {
      setBadge('WS: off', false);
      // Reconnect with backoff
      const delay = Math.min(2000 * (1 + _wsRetry++), 30_000);
      console.log(`[Liq] WS closed, reconnecting in ${delay}ms`);
      setTimeout(connectWs, delay);
    };
  }

  /* ── Init ────────────────────────────────────────────────────── */

  function init() {
    fetchLiquidations();
    setInterval(fetchLiquidations, REFRESH_MS);
    connectWs();
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
