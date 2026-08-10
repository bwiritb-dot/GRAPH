/**
 * CryptoDATEX — Horizontal Liquidation Profile & Monthly Zigzag HVN Zones
 * Drawn directly ON the lightweight-chart canvas.
 *
 * Two independent overlays sharing this file:
 *
 * 1. Liquidation profile (left edge): horizontal bars extending rightwards
 *    proportional to liquidation USD, red above current price (short
 *    liquidations / ask risk), green below (long liquidations / bid risk).
 *
 * 2. Monthly zigzag + repeated-HVN zones: over the trailing 30 days, a
 *    percentage zigzag (High/Low swings) breaks the month into alternating
 *    up/down legs. Each leg gets its own Fixed Range Volume Profile, and a
 *    High Volume Node band is only promoted to a marked zone once the same
 *    price band shows up as an HVN on 3+ DISTINCT legs going the same
 *    direction — one leg's peak is noise, three legs agreeing is a level.
 */
'use strict';

const ZCFG = {
  // Monthly zigzag detection.
  monthInterval: '1h',
  monthLookbackMs: 30 * 24 * 60 * 60 * 1000,   // trailing 30 days
  monthReqLimit: 1000,     // 30d of 1h candles is ~720 bars — fits one Binance request (cap 1500)
  zigzagDeviationPct: 4,   // swing confirmed once price retraces this % from the running extreme
  hvnMinRepeats: 3,        // a repeated HVN band must be backed by this many DISTINCT legs to be marked
  hvnMaxWidthPct: 0.005,   // a clustered zone is clamped to at most this fraction of price wide

  // Horizontal liquidation profile (left edge).
  liqStripFrac: 0.32,

  base: 'https://fapi.binance.com',
};

// ══════════════════ PURE MATH ══════════════════

/** Percentage ZigZag over High/Low: alternating swing pivots, confirmed once
 *  price retraces `deviationPct`% from the running extreme since the last
 *  confirmed pivot. Direction is seeded from the first two candles' closes.
 *
 *  The final entry is a PROVISIONAL pivot — the running extreme since the
 *  last confirmed one, even though it hasn't reversed by `deviationPct` yet.
 *  Dropping it would blind the zigzag to whatever the most recent days are
 *  doing; every function downstream treats it exactly like a real pivot; it
 *  just uses it too. Returns pivots ascending by index:
 *  [{ idx, time, price, type: 'high'|'low' }, ...] (empty if `kl` has < 2
 *  candles). Pivots strictly alternate type by construction. */
function computeZigzag(kl, deviationPct = 4) {
  if (!kl || kl.length < 2) return [];
  const dev = deviationPct / 100;

  let trend = kl[1].close >= kl[0].close ? 1 : -1;   // 1 = seeking a high, -1 = seeking a low
  const mk = (idx, price, type) => ({ idx, time: kl[idx].time, price, type });
  const pivots = [mk(0, trend === 1 ? kl[0].low : kl[0].high, trend === 1 ? 'low' : 'high')];

  let extIdx = 0;
  let extVal = trend === 1 ? kl[0].high : kl[0].low;

  for (let i = 1; i < kl.length; i++) {
    const c = kl[i];
    if (trend === 1) {
      if (c.high > extVal) { extVal = c.high; extIdx = i; }
      else if (c.low <= extVal * (1 - dev)) {
        pivots.push(mk(extIdx, extVal, 'high'));
        trend = -1; extVal = c.low; extIdx = i;
      }
    } else {
      if (c.low < extVal) { extVal = c.low; extIdx = i; }
      else if (c.high >= extVal * (1 + dev)) {
        pivots.push(mk(extIdx, extVal, 'low'));
        trend = 1; extVal = c.high; extIdx = i;
      }
    }
  }

  if (extIdx !== pivots[pivots.length - 1].idx) {
    pivots.push(mk(extIdx, extVal, trend === 1 ? 'high' : 'low'));
  }
  return pivots;
}

/** Consecutive zigzag pivot pairs → legs. A 'low'→'high' pair is an up leg,
 *  'high'→'low' is a down leg (pivots strictly alternate, so the first
 *  pivot's type alone determines it). */
function zigzagLegs(pivots) {
  const legs = [];
  for (let i = 0; i < pivots.length - 1; i++) {
    const a = pivots[i], b = pivots[i + 1];
    legs.push({ t0: a.time, t1: b.time, isUp: a.type === 'low', startPrice: a.price, endPrice: b.price });
  }
  return legs;
}

/** Promotes HVN bands that repeat across `minLegs`+ DISTINCT zigzag legs'
 *  profiles, in the same direction, into a single confirmed zone. Same-
 *  direction bands are merged by price-band overlap — transitively, so a
 *  chain of overlapping bands all join one cluster — and a cluster survives
 *  only if backed by enough distinct legs (counting legs, not raw bands,
 *  so one leg contributing two nearby peaks can't satisfy the rule alone).
 *  `rawZones`: [{p0,p1,peak,vol,isUp,legIdx,fromTime}, ...] (one entry per
 *  HVN band per leg, e.g. from findHvnZones() tagged with its leg). Returns
 *  confirmed zones ascending by price: [{p0,p1,peak,vol,isUp,repeats,fromTime}]. */
function clusterRepeatedHvn(rawZones, minLegs = 3) {
  const out = [];
  for (const isUp of [true, false]) {
    const side = rawZones.filter(z => z.isUp === isUp).sort((a, b) => a.p0 - b.p0);
    let i = 0;
    while (i < side.length) {
      let j = i, p1max = side[i].p1;
      while (j + 1 < side.length && side[j + 1].p0 <= p1max) {
        j++;
        p1max = Math.max(p1max, side[j].p1);
      }
      const members = side.slice(i, j + 1);
      const legCount = new Set(members.map(m => m.legIdx)).size;
      if (legCount >= minLegs) {
        out.push({
          p0: Math.min(...members.map(m => m.p0)),
          p1: Math.max(...members.map(m => m.p1)),
          peak: members.reduce((s, m) => s + m.peak, 0) / members.length,
          vol: members.reduce((s, m) => s + m.vol, 0),
          isUp, repeats: legCount,
          fromTime: Math.max(...members.map(m => m.fromTime)),
        });
      }
      i = j + 1;
    }
  }
  return out.sort((a, b) => a.p0 - b.p0);
}

/** Group recorded liquidation EVENTS (WebSocket collector) into price bins.
 *  Fallback source only — heatSnapshot (current outstanding pools) is
 *  preferred when CoinGlass data is available. */
function liqProfile(data, currentPrice) {
  const curP = currentPrice || 65000;
  let levels = [];

  const rawItems = (data && data.items && data.items.length) ? data.items : [];

  if (rawItems.length > 0) {
    // Group raw items into $150 price bins
    const step = curP > 1000 ? 150 : (curP > 100 ? 5 : 0.5);
    const bins = new Map();

    for (const it of rawItems) {
      if (!it.price || !it.usd) continue;
      const binPrice = Math.round(it.price / step) * step;
      const key = `${binPrice}_${it.side}`;
      const existing = bins.get(key) || { price: binPrice, usd: 0, side: it.side };
      existing.usd += it.usd;
      bins.set(key, existing);
    }

    levels = Array.from(bins.values());
  } else if (data && data.levels && data.levels.length) {
    levels = data.levels.map(l => ({
      price: l.price,
      usd: l.usd,
      side: l.price >= curP ? 'BUY' : 'SELL'
    }));
  }

  // No real data → empty profile. Never fabricate levels: fake bars at
  // fixed % offsets track the current price around and match nothing on
  // the actual chart.
  levels.sort((a, b) => a.price - b.price);
  const maxUsd = levels.length ? Math.max(...levels.map(l => l.usd)) : 0;

  return { levels, maxUsd, source: 'events' };
}

/** Fixed-range buy/sell volume profile from the candles inside `ranges`
 *  (a union of {t0,t1} windows). Each candle's volume is spread across the
 *  price rows its high–low span covers. Returns rows (ascending price),
 *  POC and the 70% Value Area, or null when no candles fall in range. */
function buildRangeProfile(kl, ranges, nRows = 50) {
  const sel = (kl || []).filter(c => ranges.some(r => c.time >= r.t0 && c.time <= r.t1));
  if (!sel.length) return null;

  let lo = Infinity, hi = -Infinity;
  for (const c of sel) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; }
  if (!(hi > lo)) hi = lo + Math.max(Math.abs(lo) * 1e-4, 1e-9);
  const rowH = (hi - lo) / nRows;

  const rows = Array.from({ length: nRows }, (_, i) => ({
    p0: lo + i * rowH, p1: lo + (i + 1) * rowH, buy: 0, sell: 0, total: 0,
  }));
  const rowIdx = p => Math.min(nRows - 1, Math.max(0, Math.floor((p - lo) / rowH)));

  for (const c of sel) {
    const buy = c.buyVol != null ? Math.min(c.buyVol, c.volume) : c.volume / 2;
    const sell = Math.max(0, c.volume - buy);
    const span = c.high - c.low;
    if (span <= rowH * 1e-6) { // flat candle: all volume in one row
      const r = rows[rowIdx(c.low)];
      r.buy += buy; r.sell += sell; r.total += c.volume;
      continue;
    }
    for (let i = rowIdx(c.low), i1 = rowIdx(c.high); i <= i1; i++) {
      const seg = Math.min(rows[i].p1, c.high) - Math.max(rows[i].p0, c.low);
      const frac = Math.max(0, seg) / span;
      rows[i].buy += buy * frac; rows[i].sell += sell * frac; rows[i].total += c.volume * frac;
    }
  }

  let pocIdx = 0;
  rows.forEach((r, i) => { if (r.total > rows[pocIdx].total) pocIdx = i; });
  const totalVol = rows.reduce((s, r) => s + r.total, 0);

  // 70% Value Area: expand from the POC toward the heavier neighbor.
  let vaSum = rows[pocIdx].total, aIdx = pocIdx, bIdx = pocIdx;
  while (vaSum < totalVol * 0.7 && (aIdx > 0 || bIdx < nRows - 1)) {
    const up = bIdx < nRows - 1 ? rows[bIdx + 1].total : -1;
    const dn = aIdx > 0 ? rows[aIdx - 1].total : -1;
    if (up >= dn) { bIdx++; vaSum += rows[bIdx].total; }
    else { aIdx--; vaSum += rows[aIdx].total; }
  }

  return {
    rows, lo, hi, totalVol,
    maxTotal: Math.max(...rows.map(r => r.total), 1e-9),
    poc: (rows[pocIdx].p0 + rows[pocIdx].p1) / 2,
    vaLow: rows[aIdx].p0, vaHigh: rows[bIdx].p1,
  };
}

/** Top-N High Volume Nodes of a profile → price bands.
 *
 *  Peaks are picked greedily by row volume, skipping rows within `minSep`
 *  rows of an already-picked peak so the N peaks are well spread out. Each
 *  peak expands up/down into a band while neighbors hold ≥ `edgeFrac` of
 *  the peak row's volume, but never wider than `maxHalf` rows per side and
 *  never past one row short of the midpoint toward the neighboring peak —
 *  so adjacent zones always keep at least one empty row between them.
 *  Returns bands sorted by price ascending: [{p0, p1, peak, vol}]. */
function findHvnZones(prof, count = 3, minSep = 6, edgeFrac = 0.5, maxHalf = 3) {
  if (!prof || !prof.rows || !prof.rows.length) return [];
  const rows = prof.rows;

  const order = rows.map((_, i) => i)
    .filter(i => rows[i].total > 0)
    .sort((a, b) => rows[b].total - rows[a].total);
  const peaks = [];
  for (const i of order) {
    if (peaks.length >= count) break;
    if (peaks.some(p => Math.abs(p - i) <= minSep)) continue;
    peaks.push(i);
  }
  peaks.sort((a, b) => a - b);

  return peaks.map((pi, k) => {
    const thr = rows[pi].total * edgeFrac;
    let loLim = k > 0 ? Math.floor((peaks[k - 1] + pi) / 2) + 1 : 0;
    let hiLim = k < peaks.length - 1 ? Math.floor((peaks[k + 1] + pi) / 2) - 1 : rows.length - 1;
    loLim = Math.max(loLim, pi - maxHalf);
    hiLim = Math.min(hiLim, pi + maxHalf);
    let a = pi, b = pi;
    while (a > loLim && rows[a - 1].total >= thr) a--;
    while (b < hiLim && rows[b + 1].total >= thr) b++;
    return { p0: rows[a].p0, p1: rows[b].p1, peak: (rows[pi].p0 + rows[pi].p1) / 2, vol: rows[pi].total };
  });
}

/** Normalize CoinGlass heatmap records {price, timestamp, volume} for
 *  drawing: drop empty cells, convert ms → s timestamps, and infer the
 *  price/time grid steps from the smallest gaps between distinct values.
 *  When `currentPrice` is given, a grid whose price band doesn't come near
 *  it is rejected — that means the data belongs to another symbol (e.g. a
 *  BTC heatmap while the chart shows ETH). */
function prepHeatmap(records, currentPrice) {
  const rs = (records || [])
    .filter(r => r && r.volume > 0 && r.price != null && r.timestamp != null)
    .map(r => ({ ...r, timestamp: r.timestamp > 1e12 ? Math.floor(r.timestamp / 1000) : r.timestamp }));
  if (!rs.length) return null;

  if (currentPrice > 0) {
    const ps = rs.map(r => r.price);
    if (Math.max(...ps) < currentPrice * 0.5 || Math.min(...ps) > currentPrice * 2) return null;
  }

  const minStep = vals => {
    const u = [...new Set(vals)].sort((a, b) => a - b);
    let m = Infinity;
    for (let i = 1; i < u.length; i++) { const d = u[i] - u[i - 1]; if (d > 0 && d < m) m = d; }
    return m === Infinity ? 0 : m;
  };
  const priceStep = minStep(rs.map(r => r.price)) || Math.max(Math.abs(rs[0].price) * 0.001, 1e-9);
  const timeStep = minStep(rs.map(r => r.timestamp)) || 300;
  const maxVol = Math.max(...rs.map(r => r.volume));
  return { records: rs, priceStep, timeStep, maxVol };
}

/** Currently OUTSTANDING liquidation pools: the newest heatmap column is
 *  CoinGlass's "now" snapshot — pools that price already swept through no
 *  longer appear in it, so every level here is by construction still
 *  standing (not taken down). Picks the strongest `topN` grid rows with a
 *  minimum separation of `sepRows` rows so one thick pool doesn't claim
 *  several adjacent bars. Returns the same shape liqProfile does. */
function heatSnapshot(heat, currentPrice, topN = 10, sepRows = 2) {
  if (!heat || !heat.records || !heat.records.length) return null;

  const byTs = new Map();
  for (const r of heat.records) {
    const arr = byTs.get(r.timestamp);
    if (arr) arr.push(r); else byTs.set(r.timestamp, [r]);
  }
  // Newest column with real depth; a freshly opened 5m bucket can be nearly
  // empty for its first seconds, in which case we step one column back.
  const tss = [...byTs.keys()].sort((a, b) => b - a);
  let asOf = tss[0];
  for (const t of tss) {
    if (byTs.get(t).length >= 3) { asOf = t; break; }
  }
  const col = byTs.get(asOf);

  const minSep = heat.priceStep * sepRows;
  const picked = [];
  for (const r of [...col].sort((a, b) => b.volume - a.volume)) {
    if (picked.length >= topN) break;
    if (picked.some(p => Math.abs(p.price - r.price) < minSep)) continue;
    picked.push(r);
  }
  if (!picked.length) return null;

  const levels = picked
    .map(r => ({ price: r.price, usd: r.volume, side: r.price >= currentPrice ? 'BUY' : 'SELL' }))
    .sort((a, b) => a.price - b.price);
  return { levels, maxUsd: Math.max(...levels.map(l => l.usd)), asOf, source: 'heat' };
}

/** Cumulative liquidation $ walking outward from current price on each side
 *  — the "Cumulative Long/Short Liquidation Leverage" curve from CoinGlass's
 *  own liquidation map, rotated onto our price (Y) axis: each point is
 *  (price, cumulative $ of every level between currentPrice and that price,
 *  inclusive). Cumulative rises monotonically walking away from currentPrice
 *  on each side, each side scaled against its OWN total (matching CoinGlass's
 *  own chart, which gives the cumulative curve a separate axis from the
 *  individual bars — the two are different orders of magnitude). Returns
 *  { above, below }, each either null (nothing on that side) or
 *  { points: [{price, cum}], total }. */
function buildCumulativeLiqCurve(levels, currentPrice) {
  if (!levels || !levels.length || !(currentPrice > 0)) return { above: null, below: null };
  const walk = side => {
    if (!side.length) return null;
    let cum = 0;
    const points = side.map(l => { cum += l.usd; return { price: l.price, cum }; });
    return { points, total: cum };
  };
  const above = walk(levels.filter(l => l.price >= currentPrice).sort((a, b) => a.price - b.price));
  const below = walk(levels.filter(l => l.price < currentPrice).sort((a, b) => b.price - a.price));
  return { above, below };
}

/** Liquidation levels that mark a disproportionate jump in standing size:
 *  walking outward from current price on each side (shorts above, longs
 *  below) separately, a level qualifies once its own $ size is at least
 *  `thresholdFrac` of everything already accumulated closer to price on that
 *  side. The first level on each side has nothing "before" it yet (running
 *  sum is still 0) and can never qualify by itself — there's nothing for it
 *  to be disproportionate relative to. Returns the qualifying levels, each
 *  tagged with the price it currently sits at (for the horizontal marker)
 *  and the cumulative sum it beat (for context). */
function findSignificantLiqZones(levels, currentPrice, thresholdFrac = 0.20) {
  if (!levels || !levels.length || !(currentPrice > 0)) return [];
  const above = levels.filter(l => l.price >= currentPrice).sort((a, b) => a.price - b.price);
  const below = levels.filter(l => l.price < currentPrice).sort((a, b) => b.price - a.price);

  const flagged = [];
  for (const side of [above, below]) {
    let cum = 0;
    for (const l of side) {
      if (cum > 0 && l.usd >= cum * thresholdFrac) flagged.push({ ...l, cumBefore: cum });
      cum += l.usd;
    }
  }
  return flagged;
}

/** Flag each zone as broken when, AFTER `afterTime`, price fully passed
 *  through the band and came out the other side (entered at one edge and
 *  later reached beyond the opposite edge — a mere touch doesn't count). */
function markZoneBreaks(zones, kl, afterTime) {
  const later = (kl || []).filter(c => c.time > afterTime);
  return zones.map(z => {
    let wasAbove = false, wasBelow = false, broken = false;
    if (later.length) {
      wasAbove = later[0].open > z.p1;
      wasBelow = later[0].open < z.p0;
    }
    for (const c of later) {
      const hitTop = c.high >= z.p1, hitBot = c.low <= z.p0;
      if ((hitTop && hitBot) || (hitBot && wasAbove) || (hitTop && wasBelow)) { broken = true; break; }
      if (hitTop) wasAbove = true;
      if (hitBot) wasBelow = true;
    }
    return { ...z, broken };
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ZCFG, computeZigzag, zigzagLegs, clusterRepeatedHvn, liqProfile,
    buildRangeProfile, findHvnZones, markZoneBreaks, prepHeatmap, heatSnapshot,
    findSignificantLiqZones, buildCumulativeLiqCurve,
  };
}

// ══════════════════ BROWSER OVERLAY RENDERER ══════════════════

if (typeof window !== 'undefined' && typeof document !== 'undefined') {

  const COL = {
    // Everything except the HVN zones and the weekly lines is a faint
    // backdrop so the zones stay the loud layer. The volume-profile rows
    // cover the widest area, so they sit lowest of all (~0.05).
    // Above price (Short liquidations): RED
    redFill:   'rgba(239, 83, 80, 0.4)',
    redStroke: 'rgba(239, 83, 80, 0.7)',
    // Below price (Long liquidations): GREEN
    greenFill:   'rgba(38, 166, 154, 0.4)',
    greenStroke: 'rgba(38, 166, 154, 0.7)',
    // Text (liq bar labels)
    textWhite:  'rgba(255, 255, 255, 0.8)',
    textGold:   'rgba(251, 191, 36, 0.8)',
    textDim:    'rgba(180, 190, 205, 0.8)',
    // Zigzag up-leg vs down-leg zones — same hues as the liq profile.
    legUp:   '38,166,154',
    legDown: '239,83,80',
    // Fixed-range volume profile rows (buy/sell split, TV-style teal/pink).
    volBuy:  'rgba(38, 166, 154, 0.05)',
    volSell: 'rgba(244, 114, 182, 0.05)',
    pocLine: 'rgba(255, 255, 255, 0.12)',
    // CoinGlass liquidation heatmap cells (amber, alpha scales with volume).
    heatBase: '251, 191, 36',
  };

  const fmtP = p => p >= 1000
    ? Math.round(p).toLocaleString('en-US')
    : p.toLocaleString('en-US', { maximumFractionDigits: 2 });

  const fmtM = usd => {
    if (!usd) return '$0M';
    const m = usd / 1e6;
    if (m >= 10) return '$' + m.toFixed(1) + 'M';
    if (m >= 0.1) return '$' + m.toFixed(2) + 'M';
    return '$' + (usd / 1e3).toFixed(0) + 'K';
  };

  /** Start of the trailing 30-day window: `nowMs` minus 30 days. */
  function monthStartMs(nowMs = Date.now()) {
    return nowMs - ZCFG.monthLookbackMs;
  }

  /** 1h candles from 30 days ago to now (~720 bars — one Binance request
   *  comfortably covers it, unlike the old 5m weekly fetch). */
  async function fetchMonthKlines(symbol) {
    const url = `${ZCFG.base}/fapi/v1/klines?symbol=${symbol}&interval=${ZCFG.monthInterval}&startTime=${monthStartMs()}&limit=${ZCFG.monthReqLimit}`;
    const raw = await (await fetch(url)).json();
    if (!Array.isArray(raw)) return [];
    // k[9] = taker-buy base volume → buy/sell split for the profile rows.
    return raw.map(k => ({
      time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], buyVol: +k[9],
    }));
  }

  async function fetchLiquidations(symbol) {
    const api = `${(window.getAppBaseUrl ? getAppBaseUrl() : '')}/api`;
    const r = await fetch(`${api}/liquidations?symbol=${symbol}`, { signal: AbortSignal.timeout(30000) });
    return r.json();
  }

  /** Full CoinGlass liquidation heatmap (last 24h, 5m grid) from our server. */
  async function fetchLiqHeatmap(symbol) {
    const api = `${(window.getAppBaseUrl ? getAppBaseUrl() : '')}/api`;
    const r = await fetch(`${api}/liquidations/heatmap?symbol=${symbol}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    return (j && j.ok && Array.isArray(j.records)) ? j.records : [];
  }

  /** CoinGlass exchange liquidation map (exLiqMap) — every liquidation level
   *  currently standing across the visible price range, summed across
   *  Binance/OKX/Bybit. Price-indexed, not time-indexed (a snapshot, not a
   *  history) — this is the left-edge liquidation profile's primary source;
   *  heatSnapshot/liqProfile below are only the fallback when it's down. */
  async function fetchLiqMap(symbol) {
    const api = `${(window.getAppBaseUrl ? getAppBaseUrl() : '')}/api`;
    const r = await fetch(`${api}/liquidations/map?symbol=${symbol}`, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!j || !j.ok || !Array.isArray(j.levels) || !j.levels.length) return null;
    return { levels: j.levels, maxUsd: Math.max(...j.levels.map(l => l.usd)), source: 'exLiqMap' };
  }

  class ZonesOverlay {
    constructor(controller, chartEl, series, chart) {
      this.ctrl = controller;
      this.chartEl = chartEl;
      this.series = series;
      this.chart = chart;
      this.cv = document.createElement('canvas');
      Object.assign(this.cv.style, {
        position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '3',
      });
      chartEl.appendChild(this.cv);
      this.ctx = this.cv.getContext('2d');
      this._sig = null;
      this._resize();
      this._ro = new ResizeObserver(() => { this._resize(); this._sig = null; });
      this._ro.observe(chartEl);
    }

    syncDraw() {
      const s = this.ctrl.state;
      if (!s) return;
      // Cheap dirty-check: redraw only when the pane size, the price->pixel
      // mapping, or the visible LOGICAL range changed. The logical range is
      // fractional, so it moves on every pixel of panning/zooming — using
      // bar times here made the overlay lag until a whole bar scrolled by.
      const lr = this.chart.timeScale().getVisibleLogicalRange();
      const priceY = this.series.priceToCoordinate(s.price);
      const sig = `${this.w}x${this.h}|${priceY}|${lr ? lr.from.toFixed(3) + '-' + lr.to.toFixed(3) : ''}`;
      if (sig === this._sig) return;
      this._sig = sig;
      this.draw();
    }

    _resize() {
      const r = this.chartEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      this.w = r.width; this.h = r.height;
      this.cv.width = r.width * dpr; this.cv.height = r.height * dpr;
      this.cv.style.width = r.width + 'px'; this.cv.style.height = r.height + 'px';
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    draw() {
      const s = this.ctrl.state, ctx = this.ctx, w = this.w, h = this.h;
      ctx.clearRect(0, 0, w, h);
      if (!s) return;
      const yOf = p => this.series.priceToCoordinate(p);
      // timeToCoordinate() only maps times that exist as bars on the current
      // timeframe; the weekly move times are 5m-exact, so on 1h/4h/1d charts
      // they fall between bars and map to null. Interpolate linearly off the
      // visible bar range instead (24/7 market — no session gaps).
      const ts = this.chart.timeScale();
      const vis = ts.getVisibleRange();
      const xOf = t => {
        const direct = ts.timeToCoordinate(t);
        if (direct !== null) return direct;
        if (!vis || vis.to === vis.from) return null;
        const xF = ts.timeToCoordinate(vis.from);
        const xT = ts.timeToCoordinate(vis.to);
        if (xF === null || xT === null) return null;
        return xF + ((t - vis.from) / (vis.to - vis.from)) * (xT - xF);
      };
      let axisW = 0;
      try { axisW = this.chart.priceScale('right').width() || 0; } catch { axisW = 0; }

      const maxStripWidth = Math.min(260, Math.max(160, w * ZCFG.liqStripFrac));
      const curPrice = s.price;

      // NOTE: the CoinGlass heatmap backdrop (raw 5m×price cells painted
      // across the price area) was removed by request — it's still fetched
      // and kept in state as `s.heat` because heatSnapshot() derives the
      // left-edge profile's fallback from it when exLiqMap is down; it's
      // simply no longer drawn over the candles.

      // ── 1) HORIZONTAL LIQUIDATION PROFILE (LEFT EDGE) ───────────────────
      const liq = s.liq;
      if (liq && liq.levels && liq.levels.length && liq.maxUsd > 0) {

        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = "bold 11px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        // The snapshot's own timestamp — CoinGlass lag plus our 5-minute
        // cache means "СЕЙЧАС" can be up to ~10 minutes behind the candles.
        const asOfStr = liq.asOf
          ? ' · ' + new Date(liq.asOf * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
          : '';
        ctx.fillText(liq.source === 'heat'
          ? `💥 ПУЛЫ ЛИКВИДНОСТИ СЕЙЧАС${asOfStr} (КРАСНЫЕ=СВЕРХУ, ЗЕЛЕНЫЕ=СНИЗУ)`
          : '💥 ЛИКВИДАЦИИ (КРАСНЫЕ=СВЕРХУ, ЗЕЛЕНЫЕ=СНИЗУ)', 8, 8);

        const barHeight = 9;
        // The bar is thinner than its label, so labels — not bars — set the
        // spacing needed to stay readable.
        const minGap = 13;

        // Zoomed out, neighbouring pools land close enough that their labels
        // collide. Keep the strongest of any colliding cluster — which pools
        // survive therefore depends on the zoom level, not on fixed spacing.
        const drawable = [];
        for (const l of [...liq.levels].sort((a, b) => b.usd - a.usd)) {
          const yc = yOf(l.price);
          if (yc === null || yc < 25 || yc > h - 30) continue;
          if (drawable.some(d => Math.abs(d.yc - yc) < minGap)) continue;
          drawable.push({ ...l, yc });
        }

        for (const l of drawable) {
          const yc = l.yc;
          const isAbove = l.price >= curPrice;
          const barW = Math.max(50, (l.usd / liq.maxUsd) * maxStripWidth);
          const yTop = yc - barHeight / 2;

          const fillCol   = isAbove ? COL.redFill   : COL.greenFill;
          const strokeCol = isAbove ? COL.redStroke : COL.greenStroke;

          ctx.fillStyle = fillCol;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(0, yTop, barW, barHeight, [0, 3, 3, 0]);
          } else {
            ctx.rect(0, yTop, barW, barHeight);
          }
          ctx.fill();

          ctx.strokeStyle = strokeCol;
          ctx.lineWidth = 1;
          ctx.stroke();

          // 10px so the label still sits within the thinner bar.
          ctx.fillStyle = COL.textWhite;
          ctx.font = "bold 10px 'JetBrains Mono', monospace";
          ctx.textBaseline = 'middle';
          const priceStr = `$${fmtP(l.price)}`;
          const priceX = Math.max(25, barW / 2);
          ctx.textAlign = 'center';
          ctx.fillText(priceStr, priceX, yc);

          ctx.fillStyle = COL.textGold;
          ctx.font = "bold 10px 'JetBrains Mono', monospace";
          ctx.textAlign = 'left';
          ctx.fillText(fmtM(l.usd), barW + 7, yc);
        }
      }

      // ── 1b) CUMULATIVE LONG/SHORT LIQUIDATION LEVERAGE CURVE ─────────────
      // CoinGlass's own liquidation-map chart pairs its per-price bars with a
      // running cumulative-$ curve; this is that curve, rotated onto our
      // price (Y) axis. Each side is scaled against its OWN total (not
      // liq.maxUsd — cumulative $ is a different order of magnitude from any
      // single bar), starting from the current-price line at 0.
      const drawCumLine = (side, rgb) => {
        if (!side || !side.points.length) return;
        const y0 = yOf(curPrice);
        if (y0 === null) return;
        ctx.beginPath();
        ctx.moveTo(0, y0);
        let any = false;
        for (const pt of side.points) {
          const y = yOf(pt.price);
          if (y === null) continue;
          const x = (pt.cum / side.total) * maxStripWidth;
          ctx.lineTo(x, y);
          any = true;
        }
        if (!any) return;
        ctx.strokeStyle = `rgba(${rgb},0.9)`;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        const last = side.points[side.points.length - 1];
        const yLast = yOf(last.price);
        if (yLast !== null && yLast >= 0 && yLast <= h) {
          ctx.fillStyle = `rgba(${rgb},0.95)`;
          ctx.font = "bold 10px 'JetBrains Mono', monospace";
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`Σ ${fmtM(side.total)}`, maxStripWidth + 4, yLast);
        }
      };
      if (s.liqCum) {
        drawCumLine(s.liqCum.above, COL.legDown); // short side, above price — red
        drawCumLine(s.liqCum.below, COL.legUp);   // long side, below price — green
      }

      // ── 2) FIXED-RANGE VOLUME PROFILES ──────────────────────────────────
      // One per zigzag leg, drawn faint — this is the "math on the graphic"
      // the marked HVN zones (step 3) get promoted out of. Legs are
      // sequential and non-overlapping by construction, so unlike the old
      // weekly system there's no window-splitting: each leg draws in its
      // own [t0,t1] only.
      const drawLegProfile = (leg, prof) => {
        const rgb = leg.isUp ? COL.legUp : COL.legDown;
        let bx0 = xOf(leg.t0), bx1 = xOf(leg.t1);
        if (bx0 === null || bx1 === null) return;
        if (Math.max(bx0, bx1) < 0 || Math.min(bx0, bx1) > w) return; // fully off-screen
        bx0 = Math.max(0, Math.min(w, bx0));
        bx1 = Math.max(0, Math.min(w, bx1));
        const yHi = yOf(prof.hi), yLo = yOf(prof.lo);
        if (yHi === null || yLo === null) return;

        // Shaded range box over the leg's traded price band.
        ctx.fillStyle = `rgba(${rgb},0.015)`;
        ctx.fillRect(bx0, yHi, bx1 - bx0, yLo - yHi);

        // Value Area (70% of volume) — brighter band inside the box.
        const yVaHi = yOf(prof.vaHigh), yVaLo = yOf(prof.vaLow);
        if (yVaHi !== null && yVaLo !== null) {
          ctx.fillStyle = `rgba(${rgb},0.02)`;
          ctx.fillRect(bx0, yVaHi, bx1 - bx0, yVaLo - yVaHi);
        }

        // Buy/sell rows, left-anchored; longest row = 80% of the leg's width
        // so the profile scales to whatever room it has.
        const maxBar = (bx1 - bx0) * 0.8;
        if (maxBar >= 10) { // leg too narrow at this zoom → skip rows, box/POC still show
          for (const row of prof.rows) {
            if (!row.total) continue;
            const y0 = yOf(row.p1), y1 = yOf(row.p0);
            if (y0 === null || y1 === null || y1 < 0 || y0 > h) continue;
            const rh = Math.max(1, y1 - y0 - 0.5);
            const bw = (row.total / prof.maxTotal) * maxBar;
            const buyW = bw * (row.buy / row.total);
            ctx.fillStyle = COL.volBuy;
            ctx.fillRect(bx0, y0, buyW, rh);
            ctx.fillStyle = COL.volSell;
            ctx.fillRect(bx0 + buyW, y0, bw - buyW, rh);
          }
        }

        // POC — the price with the most volume within this leg.
        const yPoc = yOf(prof.poc);
        if (yPoc !== null && yPoc >= 0 && yPoc <= h) {
          ctx.strokeStyle = COL.pocLine;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(bx0, yPoc + 0.5); ctx.lineTo(bx1, yPoc + 0.5); ctx.stroke();
        }
      };
      for (const { leg, prof } of s.legProfiles || []) drawLegProfile(leg, prof);

      // ── 3) CONFIRMED HVN ZONES (repeat on 3+ legs, same direction) ──────
      // Horizontal bands, extending right from the most recent contributing
      // leg's end. Intact: solid + bright. Broken (price passed clean
      // through after that leg): dashed + faded + ✗. The ×N repeat-count
      // badge is the only visible proof the "3+ profiles" rule was applied,
      // not just eyeballed off a single leg.
      const drawHvn = z => {
        const rgb = z.isUp ? COL.legUp : COL.legDown;
        let zx0 = xOf(z.fromTime);
        if (zx0 === null) zx0 = 0;
        zx0 = Math.max(0, Math.min(w, zx0));
        if (w - zx0 < 4) return; // zone start is off-screen right
        const y0 = yOf(z.p1), y1 = yOf(z.p0);
        if (y0 === null || y1 === null || y1 < 0 || y0 > h) return;

        ctx.fillStyle = `rgba(${rgb},${z.broken ? 0.05 : 0.13})`;
        ctx.fillRect(zx0, y0, w - zx0, y1 - y0);
        ctx.strokeStyle = `rgba(${rgb},${z.broken ? 0.35 : 0.8})`;
        ctx.lineWidth = 1;
        ctx.setLineDash(z.broken ? [4, 4] : []);
        ctx.strokeRect(zx0 + 0.5, y0 + 0.5, w - zx0 - 1, Math.max(1, y1 - y0 - 1));
        ctx.setLineDash([]);

        ctx.fillStyle = `rgba(${rgb},${z.broken ? 0.55 : 0.95})`;
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`HVN ${z.isUp ? '▲' : '▼'} ×${z.repeats}${z.broken ? ' ✗' : ''}`, zx0 + 6, (y0 + y1) / 2);
      };
      for (const z of s.hvnZones || []) drawHvn(z);

      // ── 4) SIGNIFICANT LIQUIDATION ZONES (20%+ jump over what's before it) ──
      // Full-width horizontal ray at the zone's price — this is a price
      // level, not a moment in time, so (unlike the weekly moves above) it
      // has to span the whole chart rather than sit between two timestamps.
      const base = (this.ctrl.symbol || 'BTCUSDT').replace(/USDT$/, '');
      for (const z of s.sigLiqZones || []) {
        const y = yOf(z.price);
        if (y === null || y < 0 || y > h) continue;
        const rgb = z.side === 'BUY' ? COL.legDown : COL.legUp; // BUY=above price=short=red, SELL=below=long=green

        ctx.strokeStyle = `rgba(${rgb},0.7)`;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); ctx.stroke();
        ctx.setLineDash([]);

        const qty = z.qty != null ? z.qty : (z.price ? z.usd / z.price : 0);
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = `rgba(${rgb},0.95)`;
        ctx.fillText(`⚠ ${qty.toFixed(2)} ${base} · ${fmtM(z.usd)}`, w - axisW - 6, y - 3);
      }
    }

    destroy() { this._ro?.disconnect(); this.cv.remove(); }
  }

  class ZonesController {
    constructor() {
      this.overlays = [];
      this.state = null;
      this.symbol = 'BTCUSDT';
      this._loading = false;
      this._tick = this._tick.bind(this);
      requestAnimationFrame(this._tick);
    }

    _tick() {
      for (const o of this.overlays) o.syncDraw();
      requestAnimationFrame(this._tick);
    }

    attach(chartEl, series, chart) {
      if (!chartEl) return;
      this.overlays.push(new ZonesOverlay(this, chartEl, series, chart));
    }

    redraw() { this.overlays.forEach(o => { o._sig = null; }); }

    async load(symbol) {
      if (symbol) this.symbol = symbol;
      if (this._loading) return;
      this._loading = true;
      try {
        const [monthKl, liq, heatRecs, liqMap] = await Promise.all([
          fetchMonthKlines(this.symbol).catch(() => []),
          fetchLiquidations(this.symbol).catch(() => ({ ok: false })),
          fetchLiqHeatmap(this.symbol).catch(() => []),
          fetchLiqMap(this.symbol).catch(() => null),
        ]);
        this.state = this._compute(monthKl, liq, heatRecs, liqMap);
        this.lastError = null;
      } catch (e) {
        // Keep the reason around — a silently empty overlay is otherwise
        // indistinguishable from "no data yet".
        this.state = null;
        this.lastError = e;
        console.warn('[Zones] load failed:', e);
      } finally {
        this._loading = false;
        this.redraw();
      }
    }

    _compute(monthKl, liq, heatRecs, liqMap) {
      if (!monthKl.length) return null;
      const price = monthKl[monthKl.length - 1].close;

      // Zigzag over the trailing month → alternating up/down legs, each
      // with its own Fixed Range Volume Profile — the "check every movement
      // up and down with a fixed volume profile" requirement.
      const pivots = computeZigzag(monthKl, ZCFG.zigzagDeviationPct);
      const legs = zigzagLegs(pivots);

      const legProfiles = [];
      const rawHvn = [];
      legs.forEach((leg, legIdx) => {
        const prof = buildRangeProfile(monthKl, [{ t0: leg.t0, t1: leg.t1 }]);
        if (!prof) return;
        legProfiles.push({ leg, prof, legIdx });
        for (const z of findHvnZones(prof)) {
          rawHvn.push({ ...z, isUp: leg.isUp, legIdx, fromTime: leg.t1 });
        }
      });

      // Only bands that repeat on 3+ DISTINCT legs, same direction, get
      // promoted — a single leg's HVN peak is not enough on its own.
      // "Broken" (price fully passed through since) is checked per zone
      // against its own most recent contributing leg's end time.
      // Clustering unions overlapping per-leg bands, which can stretch a
      // zone far wider than any single leg's own HVN — clamp the result to
      // hvnMaxWidthPct of price, centered on the cluster's own midpoint.
      const maxHvnWidth = price * ZCFG.hvnMaxWidthPct;
      const hvnZones = clusterRepeatedHvn(rawHvn, ZCFG.hvnMinRepeats)
        .map(z => {
          if (z.p1 - z.p0 <= maxHvnWidth) return z;
          const mid = (z.p0 + z.p1) / 2;
          return { ...z, p0: mid - maxHvnWidth / 2, p1: mid + maxHvnWidth / 2 };
        })
        .map(z => markZoneBreaks([z], monthKl, z.fromTime)[0]);

      // Left bars: prefer the full exchange liquidation map (exLiqMap — every
      // level currently standing across the whole visible range, summed over
      // Binance/OKX/Bybit). Falls back to the 24h heatmap's newest column,
      // then to recorded liquidation events; with no real data at all the
      // strip simply stays empty.
      const heat = prepHeatmap(heatRecs, price);
      const liqp = liqMap || heatSnapshot(heat, price) || liqProfile(liq, price);

      // Zones whose own size is a disproportionate (20%+) jump over what's
      // already accumulated closer to price on their side — only meaningful
      // against the full map, not the top-N-only fallbacks.
      const sigLiqZones = liqMap ? findSignificantLiqZones(liqMap.levels, price) : [];

      // Cumulative long/short liquidation leverage curve — same "only
      // meaningful against the full map" reasoning as sigLiqZones above.
      const liqCum = liqMap ? buildCumulativeLiqCurve(liqMap.levels, price) : { above: null, below: null };

      return { price, legProfiles, hvnZones, liq: liqp, heat, sigLiqZones, liqCum };
    }
  }

  window.Zones = new ZonesController();
}
