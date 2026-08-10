/**
 * Macro economic events — right-column panel + vertical markers on the chart.
 *
 * Source is TradingView's public calendar via /api/macro/events, filtered to
 * high-importance US/EU/DE/FR/IT/ES/CN/JP releases. Impact rank and the
 * reaction guidance come from the user's own spreadsheet (macro_meta.json),
 * joined server-side.
 *
 * The panel and the chart's vertical markers share ONE fetch of the entire
 * window the server tracks (LOOKBACK_DAYS back, LOOKAHEAD_DAYS ahead — must
 * match macro.py) — nothing is held back behind day-by-day paging, so
 * everything upcoming is always present in both places; scrolling the panel
 * or panning/zooming the chart is what reveals it, not a fetch.
 *
 * "Today" and each day's date are the viewer's local days: the browser's
 * timezone offset is sent with the request so the server can bucket by the
 * same calendar day the user sees on their own clock.
 */
'use strict';

window.Macro = (function () {
  const API_BASE = (window.location.protocol === 'file:')
    ? 'http://127.0.0.1:5050' : window.location.origin;

  const REFRESH_MS = 5 * 60 * 1000;
  const LOOKBACK_DAYS = 3;    // must match macro.py LOOKBACK_DAYS
  const LOOKAHEAD_DAYS = 21;  // must match macro.py LOOKAHEAD_DAYS
  let events = [];
  let status = null;
  let layer = null;
  let chartRef = null;
  let candleSeriesRef = null;
  let repositionQueued = false;

  const two = n => String(n).padStart(2, '0');
  const localOf = ts => new Date(ts * 1000);
  const hhmm = ts => { const d = localOf(ts); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

  // Country is no longer implied by "the panel is US-only" (it now mixes
  // US/EU/DE/FR/IT/ES/CN/JP) and TradingView's own titles don't say which
  // country a release belongs to ("Retail Sales MoM" fires for both DE and
  // EU) — a flag is the only way to tell them apart at a glance.
  const FLAG = { US: '🇺🇸', EU: '🇪🇺', DE: '🇩🇪', FR: '🇫🇷', IT: '🇮🇹', ES: '🇪🇸', CN: '🇨🇳', JP: '🇯🇵' };
  const flagOf = c => FLAG[(c || '').toUpperCase()] || '';

  function impactOf(e) {
    const p = e.meta && e.meta.power_crypto;
    if (typeof p === 'number') return p;
    return e.importance >= 1 ? 4 : 3;
  }

  function fmtVal(v, unit) {
    if (v === null || v === undefined) return null;
    const u = unit && unit !== 'None' ? unit : '';
    return `${v}${u}`;
  }

  // ── panel ───────────────────────────────────────────────────────────
  function render() {
    const list = document.getElementById('macro-list');
    if (!list) return;

    if (!events.length) {
      list.innerHTML = '<div class="macro-empty">Нет событий высокой важности<br>за выбранный период</div>';
    } else {
      const now = Date.now() / 1000;
      const groups = { 0: [], 1: [] };
      events.forEach(e => (groups[e.day_offset] || (groups[e.day_offset] = [])).push(e));

      let html = '';
      for (const off of Object.keys(groups).sort((a, b) => a - b)) {
        const items = groups[off];
        if (!items.length) continue;
        const d = localOf(items[0].ts);
        const n = Number(off);
        const label = n === 0 ? 'Сегодня' : n === 1 ? 'Завтра' : n === -1 ? 'Вчера'
          : n > 0 ? `+${n} дн` : `${n} дн`;
        html += `<div class="macro-day" data-day-offset="${n}">${label} · ${two(d.getDate())}.${two(d.getMonth() + 1)}</div>`;

        for (const e of items) {
          const imp = impactOf(e);
          const past = e.ts < now;
          const meta = e.meta || {};
          const parts = [];
          const a = fmtVal(e.actual, e.unit);
          const f = fmtVal(e.forecast, e.unit);
          const p = fmtVal(e.previous, e.unit);
          if (a !== null) {
            let cls = 'macro-actual';
            if (e.actual !== null && e.forecast !== null && e.forecast !== undefined) {
              cls += e.actual > e.forecast ? ' macro-beat' : e.actual < e.forecast ? ' macro-miss' : '';
            }
            parts.push(`<span class="${cls}">${a}</span>`);
          }
          if (f !== null) parts.push(`п:${f}`);
          if (p !== null) parts.push(`пр:${p}`);

          const tip = [
            meta.name || e.title,
            meta.criterion ? `\n\nКритерий: ${meta.criterion}` : '',
            meta.if_up ? `\n\nЕсли выше: ${meta.if_up}` : '',
            meta.if_down ? `\n\nЕсли ниже: ${meta.if_down}` : '',
            meta.caveats ? `\n\nОговорки: ${meta.caveats}` : '',
            e.source ? `\n\nИсточник: ${e.source}` : '',
          ].join('').replace(/"/g, '&quot;');

          html += `
            <div class="macro-item impact-${Math.min(5, Math.max(3, imp))}${past ? ' past' : ''}" title="${tip}">
              <span class="macro-time">${hhmm(e.ts)}</span>
              <span>
                <div class="macro-title">${flagOf(e.country)} ${e.title}</div>
                ${meta.category ? `<div class="macro-sub">${meta.category}${imp ? ` · крипто ${imp}/5` : ''}</div>` : ''}
              </span>
              <span class="macro-vals">${parts.join('<br>') || '—'}</span>
            </div>`;
        }
      }
      list.innerHTML = html;
    }

    const ts = document.getElementById('macro-ts');
    if (ts && status) {
      const age = status.ageSeconds;
      ts.textContent = status.error
        ? `ошибка: ${status.error}`
        : `${status.count} событий · обновлено ${age == null ? '—' : age + 'с назад'} · TradingView`;
      ts.style.color = status.error ? 'var(--red)' : '';
    }

    // Cache each header's scroll-content offset RIGHT NOW, while the list is
    // still scrolled to 0 — replacing innerHTML always resets scrollTop, so
    // nothing has scrolled past its own sticky threshold yet at this exact
    // point, meaning this is the one moment `getBoundingClientRect()` is
    // guaranteed to report a header's true place in the flow rather than
    // wherever it happens to be pinned. Measuring later (live, on demand)
    // was the bug: both `getBoundingClientRect()` AND `offsetTop` follow a
    // `position: sticky` element to its STUCK viewport position once it's
    // scrolled there in this engine, so comparing that against the very
    // scrollTop that caused the pinning never moved — prev/next looked
    // permanently stuck on the first day.
    const list2 = document.getElementById('macro-list');
    dayHeaderOffsets = list2 ? Array.from(list2.querySelectorAll('.macro-day'))
      .map(el => ({ off: Number(el.dataset.dayOffset), top: el.getBoundingClientRect().top - list2.getBoundingClientRect().top }))
      .sort((a, b) => a.off - b.off) : [];

    updateNav();
  }

  // ── scroll navigation (everything is already loaded — prev/next jump the
  //    scroll position between day headers instead of re-fetching a window) ─
  let dayHeaderOffsets = []; // [{off, top}], cached by render() — see there for why

  /** The day whose header is at or has scrolled past the panel's top edge —
   *  headers are `position: sticky`, so this is also whichever one the user
   *  visually sees pinned right now. */
  function topDayOffset() {
    if (!dayHeaderOffsets.length) return 0;
    const list = document.getElementById('macro-list');
    const scrollTop = list ? list.scrollTop : 0;
    let cur = dayHeaderOffsets[0];
    for (const h of dayHeaderOffsets) {
      if (h.top <= scrollTop + 2) cur = h; else break;
    }
    return cur.off;
  }

  function updateNav() {
    const range = document.getElementById('macro-range');
    const prev = document.getElementById('macro-prev');
    const next = document.getElementById('macro-next');
    if (!dayHeaderOffsets.length) {
      if (range) range.textContent = 'Нет событий';
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      return;
    }
    const cur = topDayOffset();
    if (range) {
      range.textContent = cur === 0 ? 'Сегодня' : cur === 1 ? 'Завтра' : cur === -1 ? 'Вчера'
        : cur > 0 ? `+${cur} дн` : `${cur} дн`;
    }
    if (prev) prev.disabled = cur <= dayHeaderOffsets[0].off;
    if (next) next.disabled = cur >= dayHeaderOffsets[dayHeaderOffsets.length - 1].off;
  }

  function shift(delta) {
    const list = document.getElementById('macro-list');
    if (!list || !dayHeaderOffsets.length) return;
    const cur = topDayOffset();
    const idx = dayHeaderOffsets.findIndex(h => h.off === cur);
    // Steps to the next header that HAS events, skipping empty days — a day
    // with nothing scheduled never got a header in the first place.
    const target = dayHeaderOffsets[Math.max(0, Math.min(dayHeaderOffsets.length - 1, idx + delta))];
    list.scrollTop = target.top;
    updateNav();
  }

  // ── vertical markers ────────────────────────────────────────────────
  function ensureLayer() {
    const host = document.getElementById('main-chart');
    if (!host) return null;
    if (layer && layer.parentElement === host) return layer;
    layer = document.createElement('div');
    layer.className = 'macro-vline-layer';
    host.appendChild(layer);
    return layer;
  }

  function reposition() {
    repositionQueued = false;
    const l = ensureLayer();
    if (!l || !chartRef) return;

    let scale;
    try { scale = chartRef.timeScale(); } catch (_) { return; }

    // timeToCoordinate() only maps times that land exactly on a loaded bar —
    // an upcoming release scheduled for tomorrow (or any time between bars,
    // e.g. on a 1h/4h/1d chart) has no candle yet and always came back null,
    // which is why future events silently never got a line. getVisibleRange()
    // (time-based) turned out to stay clamped to the last real bar's time
    // even once the view has been scrolled into the blank space past it
    // (main.js does that so there's room for this) — it doesn't describe
    // what's visible, just what has data. logicalToCoordinate() DOES
    // extrapolate past the last bar, so derive the equivalent logical index
    // for `t` from the series' own last two bars (index + spacing) and use
    // that instead — same trick works symmetrically before the first bar.
    let series = null;
    try { series = candleSeriesRef ? candleSeriesRef.data() : null; } catch (_) { series = null; }
    const xOf = t => {
      let direct = null;
      try { direct = scale.timeToCoordinate(t); } catch (_) { direct = null; }
      if (direct !== null && direct !== undefined && isFinite(direct)) return direct;
      if (!series || series.length < 2) return null;
      const lastIdx = series.length - 1;
      const lastBar = series[lastIdx], prevBar = series[lastIdx - 1];
      const interval = lastBar.time - prevBar.time;
      if (!(interval > 0)) return null;
      const logicalIdx = lastIdx + (t - lastBar.time) / interval;
      try { return scale.logicalToCoordinate(logicalIdx); } catch (_) { return null; }
    };

    const hostW = document.getElementById('main-chart')?.clientWidth || Infinity;
    l.innerHTML = '';

    // On the higher timeframes the visible window can span many days while
    // events only ever cover LOOKBACK_DAYS..LOOKAHEAD_DAYS — history that
    // wide packs dozens of events into a sliver of pixels at the left edge,
    // which used to pile their labels into an ever-growing vertical tower
    // (looked like a sidebar list, not markers on the timeline). Two fixes:
    // merge same-instant releases (trade balance/exports/imports, a whole
    // data dump) into one label, then only let a bounded number of rows of
    // text exist — the rest still get their tick on the timeline (that's
    // the actual "on the graphic" position), just without a label fighting
    // for the same few pixels.
    const groups = new Map();
    for (const e of events) {
      const key = `${e.ts}|${(e.country || '').toUpperCase()}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { ts: e.ts, country: e.country, items: [] });
      g.items.push(e);
    }

    const candidates = [];
    for (const g of groups.values()) {
      const x = xOf(g.ts);
      // Off-screen in either direction (event outside the visible time
      // window, or the interpolation itself came back invalid) — nothing to
      // draw here yet; it'll appear once the chart is panned/zoomed to it.
      if (x === null || x === undefined || !isFinite(x) || x < -100 || x > hostW + 100) continue;
      const imp = Math.max(...g.items.map(impactOf));
      const text = `${hhmm(g.ts)} ${flagOf(g.country)}${g.items.map(e => shortTitle(e.title)).join(', ')}`;
      candidates.push({ x, imp, text });
    }

    // Ticks for every event in view, always — cheap, and they keep the
    // timeline honest even where a label had to be dropped.
    for (const c of candidates) {
      const line = document.createElement('div');
      line.className = 'macro-vline' + (c.imp >= 4 ? '' : ' medium');
      line.style.left = `${c.x}px`;
      line.style.pointerEvents = 'auto';
      line.title = c.text;
      l.appendChild(line);
    }

    // Labels are the scarce resource: place the most important releases
    // first and stop once MAX_ROWS is full, so a dense historical cluster
    // can't grow into an unreadable column — collisions are checked against
    // every interval already placed in a row (not just the last one), since
    // importance order isn't left-to-right order.
    const MAX_ROWS = 4;
    const rows = Array.from({ length: MAX_ROWS }, () => []);
    const fits = (row, lo, hi) => !rows[row].some(iv => lo < iv.hi && hi > iv.lo);
    for (const c of [...candidates].sort((a, b) => b.imp - a.imp || a.x - b.x)) {
      const label = document.createElement('div');
      label.className = 'macro-vline-label' + (c.imp >= 4 ? '' : ' medium');
      label.style.left = `${c.x}px`;
      label.style.visibility = 'hidden';
      label.textContent = c.text;
      l.appendChild(label);
      const half = (label.offsetWidth || 70) / 2 + 3;
      const lo = c.x - half, hi = c.x + half;
      let row = 0;
      while (row < MAX_ROWS && !fits(row, lo, hi)) row++;
      if (row >= MAX_ROWS) { l.removeChild(label); continue; }
      rows[row].push({ lo, hi });
      label.style.top = `${4 + row * 15}px`;
      label.style.visibility = '';
    }
  }

  function shortTitle(t) {
    return t
      .replace('Fed Interest Rate Decision', 'FOMC')
      .replace('Non Farm Payrolls', 'NFP')
      .replace('Inflation Rate', 'CPI')
      .replace('Core Inflation Rate', 'Core CPI')
      .replace('Unemployment Rate', 'Unemp')
      .replace('Initial Jobless Claims', 'Claims')
      .replace('GDP Growth Rate', 'GDP')
      .replace(/ (MoM|YoY|QoQ|Adv|Prel|Final)$/i, '');
  }

  function queueReposition() {
    if (repositionQueued) return;
    repositionQueued = true;
    requestAnimationFrame(reposition);
  }

  function attach(chart, candleSeries) {
    chartRef = chart;
    candleSeriesRef = candleSeries;
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(queueReposition);
    } catch (_) {}
    window.addEventListener('resize', queueReposition);
    queueReposition();
  }

  // ── data ────────────────────────────────────────────────────────────
  async function refresh(force) {
    // Preserve scroll position across refreshes — render() replaces
    // #macro-list's innerHTML, which would otherwise snap the user back to
    // the top of a 24-day list every 5 minutes.
    const list = document.getElementById('macro-list');
    const scrollBefore = list ? list.scrollTop : 0;
    try {
      if (force) {
        await fetch(`${API_BASE}/api/macro/refresh`, { method: 'POST' }).catch(() => {});
      }
      const tz = new Date().getTimezoneOffset();   // minutes to add to local -> UTC
      const days = LOOKBACK_DAYS + LOOKAHEAD_DAYS + 1;
      const r = await fetch(`${API_BASE}/api/macro/events?days=${days}&tz=${tz}&offset=${-LOOKBACK_DAYS}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      events = d.events || [];
      status = d.status || null;
    } catch (e) {
      status = { error: e.message, count: events.length, ageSeconds: null };
    }
    render();
    if (list) list.scrollTop = scrollBefore;
    queueReposition();
  }

  function init() {
    refresh(false);
    setInterval(() => refresh(false), REFRESH_MS);
    let scrollQueued = false;
    document.getElementById('macro-list')?.addEventListener('scroll', () => {
      if (scrollQueued) return;
      scrollQueued = true;
      requestAnimationFrame(() => { scrollQueued = false; updateNav(); });
    });
  }

  return { init, refresh, shift, attach, reposition: queueReposition, get events() { return events; } };
})();

document.addEventListener('DOMContentLoaded', () => window.Macro.init());
