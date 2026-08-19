/**
 * CryptoDATEX — BTC Dashboard (Binance Futures)
 * Single Chart Panel with Timeframe Selector Bar (5m, 15m, 30m, 1h, 4h, 1d)
 * Unified indicator table for all TFs + TOP-10 correlations
 */
'use strict';

function getAppBaseUrl() {
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') return 'http://127.0.0.1:5050';
  return (typeof window !== 'undefined' && window.location.origin) ? window.location.origin : 'http://127.0.0.1:5050';
}

const API    = `${getAppBaseUrl()}/api`;
const SYMBOL = 'BTCUSDT';
let ACTIVE_SYMBOL = SYMBOL;
let ACTIVE_TF     = '5m';

const ALL_TFS = ['5m', '15m', '30m', '1h', '4h', '1d'];

// Every timeframe's last payload, kept so the indicator table can follow the
// crosshair on all six rows at once. loadAll() used to fetch these, write the
// final bar into the table and throw the rest away, which is why hovering the
// chart only ever moved the active timeframe's row.
const TF_CACHE = Object.create(null);

// Index of the last bar that had already opened at time `t` — i.e. the bar
// whose close is the most recent one available at that moment on that
// timeframe. Bars are ascending by time, so binary search.
function barIndexAt(ohlcv, t) {
  let lo = 0, hi = ohlcv.length - 1, res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ohlcv[mid].time <= t) { res = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return res;
}

// Re-point every row of the indicator table at time `t`. Passing null snaps
// all rows back to their latest closed bar.
function updateTableAtTime(t) {
  for (const tf of ALL_TFS) {
    const d = TF_CACHE[tf];
    if (!d?.ohlcv?.length || !d.indicators) continue;
    const idx = t == null ? d.ohlcv.length - 1 : barIndexAt(d.ohlcv, t);
    if (idx >= 0) updateTableRow(tf, d.indicators, idx);
  }
}

// ── Indicator tabs per panel ──────────────────────────────────────────
const IND_TABS = [
  { id:'wtmo',  label:'WTMO', title:'WaveTrend Momentum Oscillator' },
  { id:'mlmi',  label:'MLMI', title:'Machine Learning Momentum Index (kNN)' },
  { id:'rsi',   label:'RSI',  title:'Relative Strength Index (14)' },
  { id:'mfi',   label:'MFI',  title:'Money Flow Index (14)' },
  { id:'cci',   label:'CCI',  title:'Commodity Channel Index (20)' },
  { id:'willr', label:'W%R',  title:'Williams Percent Range (14)' },
  { id:'uo',    label:'UO',   title:'Ultimate Oscillator (7/14/28)' },
  { id:'adx',   label:'ADX',  title:'ADX + DM+/DM- (14)' },
  { id:'cmf',   label:'CMF',  title:'Chaikin Money Flow (20)' },
  { id:'cvd',   label:'CVD',  title:'Cumulative Volume Delta (window)' },
  { id:'depth', label:'DEPTH', title:'Order Book Depth — resting bid/ask volume at ±2/5/10%' },
];

// Bands drawn on the DEPTH indicator pane. The backend tracks nine
// (1/2/3/5/8/10/20/40/60 %); these three are the default view.
const DEPTH_BANDS = [
  { pct: 2,  bid: '#00e676', ask: '#ff5252' },
  { pct: 5,  bid: '#00bfa5', ask: '#ff7043' },
  { pct: 10, bid: '#00838f', ask: '#c62828' },
];

// The depth series is sampled at 1 Hz and shared by every timeframe, so it is
// fetched once and re-bucketed per chart rather than re-requested on each tab
// switch. 86400 samples is the backend's full retained window.
const DEPTH_CACHE = { ts: 0, history: [], inflight: null };
const DEPTH_CACHE_MS = 20000;

// Primary series data-key per tab, used to project the crosshair's vertical
// line from one chart onto the other (see ChartPanel#_subscribeCrosshair).
const PRIMARY_IND_KEY = {
  wtmo:'wt1', mlmi:'mlmi', rsi:'rsi', mfi:'mfi', cci:'cci',
  willr:'willr', uo:'uo', adx:'adx', cmf:'cmf', cvd:'cvd',
};

// ── Unified indicator table columns ────────────────────────────────────
const IND_TABLE_COLS = [
  { key:'wt1',   thKey:'wtmo',  fmt: v => v.toFixed(1) },
  { key:'mlmi',  thKey:'mlmi',  fmt: v => v.toFixed(1) },
  { key:'rsi',   thKey:'rsi',   fmt: v => v.toFixed(1) },
  { key:'mfi',   thKey:'mfi',   fmt: v => v.toFixed(1) },
  { key:'cci',   thKey:'cci',   fmt: v => v.toFixed(0) },
  { key:'willr', thKey:'willr', fmt: v => v.toFixed(1) },
  { key:'uo',    thKey:'uo',    fmt: v => v.toFixed(1) },
  { key:'adx',   thKey:'adx',   fmt: v => v.toFixed(1) },
  { key:'dmp',   thKey:'dmp',   fmt: v => v.toFixed(1) },
  { key:'dmm',   thKey:'dmm',   fmt: v => v.toFixed(1) },
  { key:'cmf',   thKey:'cmf',   fmt: v => v.toFixed(3) },
];

// ── Volume recolouring rule ────────────────────────────────────────────
// Ported from VOLUDE.PINE ("Buy/Sell Volume Compact 20% + SMA") for exact
// parity with the reference TradingView indicator. Three escalating tiers
// per side, both a volume-spike AND a one-sided-close condition required.
//
// Earlier calibration note (now obsolete — kept for context): buyRatio used
// to be computed from taker_buy/volume (real trade data), and 80%+ skew was
// measured to be unreachable on liquid 5m BTCUSDT bars, which is why the
// threshold had been lowered to 70%. Pine's buyPercent is NOT taker-flow
// based — it's (close-low)/(high-low), the close's position within the
// bar's own range — which routinely reaches 90%+ on a trending candle. That
// mismatch, not the threshold value, was why on-chart colouring was sparse
// compared to the Pine reference.
//
// Level 1 (multiple/buyRatio) is overridden at runtime from
// /api/telegram/config so the alert threshold and the on-chart colours can
// never disagree. Levels 2/3 are fixed, matching Pine exactly (it doesn't
// expose them as inputs either).
const VOL_RULE = {
  multiple: 2.0, buyRatio: 0.75, maLength: 20,      // level 1 — pale
  multiple2: 2.5, buyRatio2: 0.80,                   // level 2 — bright
  multiple3: 3.0, buyRatio3: 0.90,                   // level 3 — super
};
window.VOL_RULE = VOL_RULE;

// Exact RGB values from VOLUDE.PINE.
const VOL_COLORS = {
  baseUp:      'rgba(128,128,128,0.55)',   // lightGrayColor, close >= open
  baseDown:    'rgba(128,128,128,0.30)',   // darkGrayColor,  close <  open
  buyPale:     'rgba(120,220,160,1)',
  buyBright:   'rgba(0,220,100,1)',
  buySuper:    'rgba(0,255,80,1)',
  sellPale:    'rgba(255,170,190,1)',
  sellBright:  'rgba(255,90,150,1)',
  sellSuper:   'rgba(255,0,120,1)',
};

const TH = {
  wtmo:  { ob:60,   os:-60,  obn:45,   osn:-45 },
  mlmi:  { ob:70,   os:-70,  obn:50,   osn:-50 },
  rsi:   { ob:80,   os:20,   obn:70,   osn:30  },
  mfi:   { ob:85,   os:15,   obn:75,   osn:25  },
  cci:   { ob:120,  os:-120, obn:80,   osn:-80 },
  willr: { ob:-10,  os:-90,  obn:-20,  osn:-80 },
  uo:    { ob:60,   os:40,   obn:55,   osn:45  },
  adx:   { l1:20,  l2:30,  l3:40 },
  dmp:   { l1:20,  l2:30,  l3:40 },
  dmm:   { l1:20,  l2:30,  l3:40 },
  cmf:   { bull:0.2, bear:-0.2 },
};

function getState(thKey, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'st-neutral';
  const th = TH[thKey];
  if (!th) return 'st-neutral';
  if ('bull' in th) {
    if (value >= th.bull) return 'st-bull';
    if (value <= th.bear) return 'st-bear';
    return 'st-neutral';
  }
  if ('l1' in th) {
    if (value >= th.l3) return 'st-adx-l3';
    if (value >= th.l2) return 'st-adx-l2';
    if (value >= th.l1) return 'st-adx-l1';
    return 'st-neutral';
  }
  if (value >= th.ob)  return 'st-ob';
  if (value >= th.obn) return 'st-ob-near';
  if (value <= th.os)  return 'st-os';
  if (value <= th.osn) return 'st-os-near';
  return 'st-neutral';
}

function updateTableRow(tf, ind, idx) {
  if (!ind) return;
  for (const col of IND_TABLE_COLS) {
    const el = document.getElementById(`tc-${tf}-${col.key}`);
    if (!el) continue;
    const raw = ind[col.key]?.[idx];
    const v   = (raw !== null && raw !== undefined && !Number.isNaN(+raw)) ? +raw : null;
    el.textContent = v !== null ? col.fmt(v) : '—';
    el.className   = `ind-cell ${getState(col.thKey, v)}`;
  }
}

// Fixed right price-scale width shared by mainChart and indChart. A single
// constant keeps both plot areas pixel-identical without measuring/race
// conditions. Measured natural need tops out at 70px (main candle price,
// e.g. "65,700.00") / 64px (indicator hline labels); the extra headroom
// covers a 6-figure BTC price and larger screen DPI without wasting space.
const PRICE_SCALE_WIDTH = 82;

const C = {
  bg:'#12121a', grid:'rgba(255,255,255,0.035)', text:'#555570',
  border:'rgba(255,255,255,0.055)',
  up:'#26a69a', dn:'#ef5350',
  upDim:'rgba(38,166,154,0.22)', dnDim:'rgba(239,83,80,0.22)',
  white:'rgba(230,230,245,0.88)', whiteDim:'rgba(230,230,245,0.25)',
  orange:'#f7931a', blue:'#00d4ff', yellow:'#fbbf24',
  purple:'#a855f7', cyan:'#31ffc8', indigo:'#426eff',
  volBullBase:'rgba(168,168,182,0.55)', volBearBase:'rgba(118,118,132,0.72)',
};

// Bar times arrive as UTC-epoch seconds (Binance klines), and lightweight-
// charts' own default tick/crosshair formatters render them with UTC getters
// — that made the axis show UTC instead of the viewer's own clock. These use
// plain (non-UTC) Date getters, which JS resolves in the browser's local
// timezone, so the axis now matches the LOCAL world-clock in the header.
const _two = n => String(n).padStart(2, '0');
function localTickMarkFormatter(time, tickMarkType) {
  const d = new Date(time * 1000);
  const TMT = LightweightCharts.TickMarkType;
  switch (tickMarkType) {
    case TMT.Year:          return String(d.getFullYear());
    case TMT.Month:         return d.toLocaleDateString('ru-RU', { month: 'short', year: 'numeric' });
    case TMT.DayOfMonth:    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
    case TMT.TimeWithSeconds: return `${_two(d.getHours())}:${_two(d.getMinutes())}:${_two(d.getSeconds())}`;
    default:                return `${_two(d.getHours())}:${_two(d.getMinutes())}`;
  }
}
function localTimeFormatter(time) {
  const d = new Date(time * 1000);
  return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' })}  ${_two(d.getHours())}:${_two(d.getMinutes())}:${_two(d.getSeconds())}`;
}

// ════════════════════════════════════════════════════════════════════
//  Single ChartPanel
// ════════════════════════════════════════════════════════════════════
class ChartPanel {
  constructor() {
    this.tf = ACTIVE_TF;
    this.activeTab = 'wtmo';
    this.data = null;
    this.activeSeries = [];
    this.activeHistSeries = [];
    this.candleSeries = null;
    this.volSeries = null;
    this._timeToIdx = new Map();
    this._crosshairInfoHandler = null;
    this._lastAlertedBar = null;

    this.mainChartEl     = document.getElementById('main-chart');
    this.indChartEl      = document.getElementById('ind-main');
    this.tabsEl          = document.getElementById('tabs-main');
    this.infoOverlayEl   = document.getElementById('chart-info-overlay');

    this._buildUI();
  }

  _buildUI() {
    if (!this.mainChartEl || !this.indChartEl) return;

    this.mainChart = LightweightCharts.createChart(this.mainChartEl, {
      layout: { background: { color: C.bg }, textColor: C.text },
      grid:   { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: {
        borderColor: C.border, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: localTickMarkFormatter,
      },
      rightPriceScale: {
        borderColor: C.border,
        autoScale: true,
        minimumWidth: PRICE_SCALE_WIDTH,
        scaleMargins: {
          top: 0.03,
          bottom: 0.20,  // Reserve bottom 20% for the volume band below
        },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    this.candleSeries = this.mainChart.addCandlestickSeries({
      upColor: C.up, downColor: C.dn,
      borderUpColor: C.up, borderDownColor: C.dn,
      wickUpColor: C.up, wickDownColor: C.dn,
    });

    // VWAP (rolling 24-bar) + +-1sigma/+-2sigma bands, overlaid on the price scale.
    this.vwapSeries = this.mainChart.addLineSeries({
      color: C.blue, lineWidth: 2, title: 'VWAP',
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.vwapU1Series = this.mainChart.addLineSeries({
      color: 'rgba(0,212,255,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.vwapD1Series = this.mainChart.addLineSeries({
      color: 'rgba(0,212,255,0.45)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.vwapU2Series = this.mainChart.addLineSeries({
      color: 'rgba(0,212,255,0.22)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.vwapD2Series = this.mainChart.addLineSeries({
      color: 'rgba(0,212,255,0.22)', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    this.volSeries = this.mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      autoscaleInfoProvider: () => ({
        priceRange: {
          minValue: 0,
          maxValue: this._maxVolume || 1,
        },
        margins: {
          above: 0,
          below: 0,
        },
      }),
    });

    this.volMaSeries = this.mainChart.addLineSeries({
      priceScaleId: 'volume',
      color: '#f7931a',   // Vol MA 20 orange line
      lineWidth: 1.5,
      title: 'Vol MA 20',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    // Must run AFTER a series has attached to 'volume' — applying these
    // margins before any series claims the scale gets silently discarded
    // (the scale resets to library defaults once the first series binds
    // to it), which is why volume used to render ~4x taller than intended.
    this.mainChart.priceScale('volume').applyOptions({
      scaleMargins: {
        top: 0.81,   // Volume band = bottom 19% of the pane
        bottom: 0,   // baseline (0 volume) sits exactly on the pane's bottom edge
      },
      visible: false,  // Hide volume numbers from right price axis
      alignLabels: false,
      borderVisible: false,
    });

    window.Zones?.attach(this.mainChartEl, this.candleSeries, this.mainChart);
    window.Ruler?.attach(this.mainChartEl, this.candleSeries, this.mainChart);
    // Vertical markers for scheduled macro releases. Positioned from the time
    // scale rather than drawn as a series — a series is a function of time and
    // so cannot span price at a single instant.
    window.Macro?.attach(this.mainChart, this.candleSeries);

    this.indChart = LightweightCharts.createChart(this.indChartEl, {
      layout: { background: { color: C.bg }, textColor: C.text },
      grid:   { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: {
        borderColor: C.border, timeVisible: true, secondsVisible: false,
        tickMarkFormatter: localTickMarkFormatter,
      },
      rightPriceScale: { borderColor: C.border, autoScale: true, minimumWidth: PRICE_SCALE_WIDTH },
    });

    // Build indicator tabs
    if (this.tabsEl) {
      this.tabsEl.innerHTML = IND_TABS.map(t =>
        `<button class="tab-btn${t.id === this.activeTab ? ' active' : ''}"
                 data-tab="${t.id}" title="${t.title}">${t.label}</button>`
      ).join('');

      this.tabsEl.addEventListener('click', e => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        this.tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
        this.activeTab = tab;
        this._renderIndicator(tab);
      });
    }

    this._syncTimeScales();
  }

  _syncTimeScales() {
    let syncMain = false, syncInd = false;
    this.mainChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (syncMain || !r) return;
      syncInd = true;
      try { this.indChart.timeScale().setVisibleLogicalRange(r); } catch(_) {}
      syncInd = false;
    });
    this.indChart.timeScale().subscribeVisibleLogicalRangeChange(r => {
      if (syncInd || !r) return;
      syncMain = true;
      try { this.mainChart.timeScale().setVisibleLogicalRange(r); } catch(_) {}
      syncMain = false;
    });
  }

  async load(tf) {
    if (tf) this.tf = tf;
    document.getElementById('loading-main')?.classList.remove('hidden');
    try {
      const resp = await fetch(`${API}/data/${this.tf}?symbol=${ACTIVE_SYMBOL}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      this.data = data;
      const ohlcv = data.ohlcv;

      this._timeToIdx = new Map(ohlcv.map((d, i) => [d.time, i]));

      this.candleSeries.setData(ohlcv.map(d => ({
        time: d.time, open: d.open, high: d.high, low: d.low, close: d.close,
      })));
      this._renderVolume();
      this._renderVwap();
      this.mainChart.timeScale().fitContent();
      this.mainChart.priceScale('right').applyOptions({ autoScale: true });

      this._updateOHLCVRaw(ohlcv[ohlcv.length - 1]);
      updateTableRow(this.tf, this.data.indicators, ohlcv.length - 1);
      this._subscribeCrosshair();
      this._renderIndicator(this.activeTab);
      this._updateInfoOverlay(ohlcv.length - 1);

      document.getElementById('loading-main')?.classList.add('hidden');
      return true;
    } catch (err) {
      console.error(`[${this.tf}]`, err);
      document.getElementById('loading-main')?.classList.add('hidden');
      return false;
    }
  }

  _updateOHLCVRaw(d) {
    if (!d) return;
    const fmt = v => v != null
      ? (+v).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—';
    const g = id => document.getElementById(id);
    if (g('o-main')) g('o-main').textContent = fmt(d.open  ?? d.Open);
    if (g('h-main')) g('h-main').textContent = fmt(d.high  ?? d.High);
    if (g('l-main')) g('l-main').textContent = fmt(d.low   ?? d.Low);
    if (g('c-main')) g('c-main').textContent = fmt(d.close ?? d.Close);
    if (g('v-main')) g('v-main').textContent =
      d.volume != null ? Math.round(d.volume).toLocaleString() : '—';
  }

  _updateInfoOverlay(idx) {
    if (!this.infoOverlayEl) return;
    const ind = this.data?.indicators;
    const row = this.data?.ohlcv?.[idx];
    if (!ind || !row) return;

    const vwap = ind.vwap?.[idx];
    const u1 = ind.vwap_u1?.[idx], d1 = ind.vwap_d1?.[idx];
    const cvd = ind.cvd?.[idx];
    const fmtP = v => v == null ? '—' : (+v).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const fmtDiff = v => v == null ? '' : ` (${(row.close - v) >= 0 ? '+' : ''}${Math.round(row.close - v).toLocaleString('en-US')})`;
    const fmtCvd = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;

    this.infoOverlayEl.innerHTML = `
      <div class="cio-row"><span class="cio-key" style="color:${C.blue}">VWAP</span>
        <span class="cio-val">${fmtP(vwap)}</span><span class="cio-diff">${fmtDiff(vwap)}</span></div>
      <div class="cio-row cio-sub"><span class="cio-key">±1σ</span>
        <span class="cio-val">${fmtP(d1)} / ${fmtP(u1)}</span></div>
      <div class="cio-row"><span class="cio-key" style="color:${cvd >= 0 ? C.up : C.dn}">CVD</span>
        <span class="cio-val" style="color:${cvd >= 0 ? C.up : C.dn}">${fmtCvd(cvd)}</span></div>
    `;
  }

  // Keeps the crosshair's vertical (time) line continuous across both charts:
  // each chart's real mouse-driven crosshair move projects a matching
  // setCrosshairPosition() onto the other chart. Guard flags stop the
  // projected move from re-triggering the source chart's own handler.
  _subscribeCrosshair() {
    if (this._crosshairMainHandler) this.mainChart.unsubscribeCrosshairMove(this._crosshairMainHandler);
    if (this._crosshairIndHandler)  this.indChart.unsubscribeCrosshairMove(this._crosshairIndHandler);

    let suppressMain = false, suppressInd = false;

    const updateInfo = idx => {
      const ohlcv = this.data?.ohlcv;
      if (!ohlcv?.[idx]) return;
      this._updateOHLCVRaw(ohlcv[idx]);
      // Every timeframe follows the crosshair, each showing the last bar that
      // had closed at that moment — not just the active one.
      updateTableAtTime(ohlcv[idx].time);
      this._updateInfoOverlay(idx);
    };

    this._crosshairMainHandler = param => {
      if (suppressMain) return;
      if (!param?.time || !param.point) {
        suppressInd = true;
        try { this.indChart.clearCrosshairPosition(); } catch(_) {}
        suppressInd = false;
        updateTableAtTime(null);      // cursor left the chart — snap back to live
        return;
      }
      const idx = this._timeToIdx.get(param.time);
      if (idx !== undefined) updateInfo(idx);
      const key = PRIMARY_IND_KEY[this.activeTab];
      const val = idx !== undefined ? this.data?.indicators?.[key]?.[idx] : null;
      if (val != null && this.activeSeries[0]) {
        suppressInd = true;
        try { this.indChart.setCrosshairPosition(val, param.time, this.activeSeries[0]); } catch(_) {}
        suppressInd = false;
      }
    };

    this._crosshairIndHandler = param => {
      if (suppressInd) return;
      if (!param?.time || !param.point) {
        suppressMain = true;
        try { this.mainChart.clearCrosshairPosition(); } catch(_) {}
        suppressMain = false;
        updateTableAtTime(null);      // cursor left the chart — snap back to live
        return;
      }
      const idx = this._timeToIdx.get(param.time);
      if (idx !== undefined) updateInfo(idx);
      const row = idx !== undefined ? this.data?.ohlcv?.[idx] : null;
      if (row && this.candleSeries) {
        suppressMain = true;
        try { this.mainChart.setCrosshairPosition(row.close, param.time, this.candleSeries); } catch(_) {}
        suppressMain = false;
      }
    };

    this.mainChart.subscribeCrosshairMove(this._crosshairMainHandler);
    this.indChart.subscribeCrosshairMove(this._crosshairIndHandler);
  }

  liveUpdate(candle) {
    if (!this.candleSeries) return;
    this.candleSeries.update({
      time: candle.time, open: candle.open, high: candle.high,
      low: candle.low, close: candle.close,
    });
    this._mergeLiveCandle(candle);
    this._renderVolume();
    this._updateOHLCVRaw(candle);
    window.Zones?.redraw();
    if (candle.closed) this._refreshIndicators();
  }

  _mergeLiveCandle(candle) {
    if (!this.data?.ohlcv) return;
    const nextBar = {
      time: candle.time, open: candle.open, high: candle.high,
      low: candle.low, close: candle.close, volume: candle.volume,
    };
    const rows = this.data.ohlcv;
    const last = rows[rows.length - 1];
    if (!last) { rows.push(nextBar); this._timeToIdx.set(nextBar.time, 0); return; }
    if (last.time === nextBar.time) { rows[rows.length - 1] = nextBar; this._timeToIdx.set(nextBar.time, rows.length - 1); return; }
    if (last.time < nextBar.time) { rows.push(nextBar); this._timeToIdx.set(nextBar.time, rows.length - 1); return; }
  }

  async _refreshIndicators() {
    try {
      const resp = await fetch(`${API}/data/${this.tf}?symbol=${ACTIVE_SYMBOL}`);
      if (!resp.ok) return;
      const nd = await resp.json();
      if (nd.error) return;
      this.data = nd;
      this._timeToIdx = new Map(nd.ohlcv.map((d, i) => [d.time, i]));
      this._renderVolume();
      this._renderVwap();
      this._renderIndicator(this.activeTab);
      updateTableRow(this.tf, nd.indicators, nd.ohlcv.length - 1);
      this._updateInfoOverlay(nd.ohlcv.length - 1);
    } catch(_) {}
  }

  _renderVwap() {
    if (!this.data?.ohlcv || !this.vwapSeries) return;
    const { ohlcv, indicators: ind } = this.data;
    const times = ohlcv.map(d => d.time);
    this.vwapSeries.setData(this._toPts(times, ind.vwap));
    this.vwapU1Series.setData(this._toPts(times, ind.vwap_u1));
    this.vwapD1Series.setData(this._toPts(times, ind.vwap_d1));
    this.vwapU2Series.setData(this._toPts(times, ind.vwap_u2));
    this.vwapD2Series.setData(this._toPts(times, ind.vwap_d2));
  }

  _renderVolume() {
    if (!this.data?.ohlcv || !this.volSeries) return;
    const ohlcv = this.data.ohlcv;
    const N = VOL_RULE.maLength;

    // Scale the band to the 95th percentile rather than the outright max.
    // A single 6x spike would otherwise compress every ordinary bar into a
    // couple of pixels. Bars above the cap clip at the top of the band,
    // which makes the spikes read as spikes instead of dwarfing the rest.
    const sortedVol = ohlcv.map(d => d.volume).filter(v => v > 0).sort((a, b) => a - b);
    this._maxVolume = sortedVol.length
      ? sortedVol[Math.min(sortedVol.length - 1, Math.floor(sortedVol.length * 0.95))]
      : 1;

    const volData = [];
    const volMaData = [];

    for (let i = 0; i < ohlcv.length; i++) {
      const d = ohlcv[i];

      // Volume MA (20)
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - N + 1); j <= i; j++) {
        sum += ohlcv[j].volume;
        count++;
      }
      const ma = count > 0 ? sum / count : d.volume;

      // Buy% = where close sits within the bar's own high-low range — this
      // is VOLUDE.PINE's actual formula (NOT taker_buy/volume). See the
      // VOL_RULE comment above for why that distinction matters.
      const barRange = d.high - d.low;
      const buyPercent  = barRange !== 0 ? (d.close - d.low) / barRange : 0.5;
      const sellPercent = 1 - buyPercent;
      const volumeRatio = ma > 0 ? d.volume / ma : 0;

      const buyLevel3  = volumeRatio >= VOL_RULE.multiple3 && buyPercent  >= VOL_RULE.buyRatio3;
      const buyLevel2  = volumeRatio >= VOL_RULE.multiple2 && buyPercent  >= VOL_RULE.buyRatio2;
      const buyLevel1  = volumeRatio >= VOL_RULE.multiple  && buyPercent  >= VOL_RULE.buyRatio;
      const sellLevel3 = volumeRatio >= VOL_RULE.multiple3 && sellPercent >= VOL_RULE.buyRatio3;
      const sellLevel2 = volumeRatio >= VOL_RULE.multiple2 && sellPercent >= VOL_RULE.buyRatio2;
      const sellLevel1 = volumeRatio >= VOL_RULE.multiple  && sellPercent >= VOL_RULE.buyRatio;

      const color =
        buyLevel3  ? VOL_COLORS.buySuper   :
        buyLevel2  ? VOL_COLORS.buyBright  :
        buyLevel1  ? VOL_COLORS.buyPale    :
        sellLevel3 ? VOL_COLORS.sellSuper  :
        sellLevel2 ? VOL_COLORS.sellBright :
        sellLevel1 ? VOL_COLORS.sellPale   :
        (d.close >= d.open ? VOL_COLORS.baseUp : VOL_COLORS.baseDown);

      volData.push({ time: d.time, value: d.volume, color });
      volMaData.push({ time: d.time, value: ma });

      // The still-forming last bar just turned a signal colour — tell the
      // server right now instead of waiting for it to close. Fires once per
      // bar (see _pokeLiveVolumeAlert's dedup); the server independently
      // re-checks the rule against live data before sending anything.
      if (i === ohlcv.length - 1 &&
          (buyLevel1 || buyLevel2 || buyLevel3 || sellLevel1 || sellLevel2 || sellLevel3)) {
        this._pokeLiveVolumeAlert(d.time);
      }
    }

    this.volSeries.setData(volData);
    if (this.volMaSeries) this.volMaSeries.setData(volMaData);
  }

  _pokeLiveVolumeAlert(barTime) {
    if (this._lastAlertedBar === barTime) return;
    this._lastAlertedBar = barTime;
    fetch(`${API}/telegram/volume-live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tf: this.tf }),
    }).catch(() => {});
  }

  _clearIndicator() {
    this.activeSeries.forEach(s => { try { this.indChart.removeSeries(s); } catch(_) {} });
    this.activeSeries = [];
    this._depthNote(null);   // the DEPTH tab's overlay must not outlive its pane
  }

  // Emits one point per bar, always — indicator warm-up bars with no value
  // become whitespace points ({time} with no `value`). Dropping them entirely
  // would shrink indChart's own bar list relative to mainChart's, which
  // desyncs the two charts' logical-index <-> time mapping (they'd agree on
  // "show index 20..150" while disagreeing on which real bar index 20 is)
  // and throws off the shared crosshair/visible-range sync by a constant
  // bar-count offset.
  _toPts(times, vals, colorFn=null) {
    const out = [];
    if (!vals || !times) return out;
    for (let i = 0; i < times.length; i++) {
      const v = vals[i];
      if (v === null || v === undefined || Number.isNaN(v)) {
        out.push({ time: times[i] });
        continue;
      }
      const pt = { time: times[i], value: +v };
      if (colorFn) pt.color = colorFn(+v, i, vals);
      out.push(pt);
    }
    return out;
  }

  _addLine(data, color, width=1, title='') {
    const s = this.indChart.addLineSeries({
      color, lineWidth: width, lastValueVisible: true,
      priceLineVisible: false, title, crosshairMarkerVisible: false,
    });
    s.setData(data); this.activeSeries.push(s); return s;
  }

  // Fakes per-bar line colouring (lightweight-charts v4 line series only take
  // one flat color) by splitting the series into one sub-series per run of
  // consecutive same-color bars. Each run repeats its predecessor's last
  // point so the segments visually touch with no gap. Used to mirror
  // ADX.pine's `color2 = adx > adx[1] ? green : red`.
  _addColoredLine(times, vals, colorFn, width=1, title='') {
    const n = times.length;
    let i = 0;
    const created = [];
    while (i < n) {
      if (vals[i] == null || Number.isNaN(vals[i])) { i++; continue; }
      const color = colorFn(vals[i], i);
      const segTimes = [], segVals = [];
      if (i > 0 && vals[i-1] != null && !Number.isNaN(vals[i-1])) {
        segTimes.push(times[i-1]); segVals.push(vals[i-1]);
      }
      let j = i;
      while (j < n && vals[j] != null && !Number.isNaN(vals[j]) && colorFn(vals[j], j) === color) {
        segTimes.push(times[j]); segVals.push(vals[j]);
        j++;
      }
      const isLast = j >= n;
      const s = this.indChart.addLineSeries({
        color, lineWidth: width, title: isLast ? title : '',
        lastValueVisible: isLast, priceLineVisible: false, crosshairMarkerVisible: false,
      });
      s.setData(segTimes.map((t, k) => ({ time: t, value: segVals[k] })));
      this.activeSeries.push(s);
      created.push(s);
      i = j;
    }
    return created;
  }

  _addHist(data, title='') {
    const s = this.indChart.addHistogramSeries({ lastValueVisible: true, priceLineVisible: false, title });
    s.setData(data); this.activeSeries.push(s); return s;
  }

  _addBaseline(data, title='') {
    const s = this.indChart.addBaselineSeries({
      baseValue: { type: 'price', price: 0 },
      topLineColor: C.up, topFillColor1: 'rgba(38,166,154,0.28)', topFillColor2: 'rgba(38,166,154,0.05)',
      bottomLineColor: C.dn, bottomFillColor1: 'rgba(239,83,80,0.05)', bottomFillColor2: 'rgba(239,83,80,0.28)',
      lineWidth: 2, lastValueVisible: true, priceLineVisible: false, title,
    });
    s.setData(data); this.activeSeries.push(s); return s;
  }

  _hline(series, price, color, label='') {
    series.createPriceLine({ price, color, lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: !!label, title: label });
  }

  _renderIndicator(tabId) {
    this._clearIndicator();
    if (!this.data) return;
    const { ohlcv, indicators: ind } = this.data;
    const times = ohlcv.map(d => d.time);

    const dispatch = {
      wtmo:  () => this._rWTMO(times, ind),
      mlmi:  () => this._rMLMI(times, ind),
      rsi:   () => this._rRSI(times, ind),
      mfi:   () => this._rMFI(times, ind),
      cci:   () => this._rCCI(times, ind),
      willr: () => this._rWillR(times, ind),
      uo:    () => this._rUO(times, ind),
      adx:   () => this._rADX(times, ind),
      cmf:   () => this._rCMF(times, ind),
      cvd:   () => this._rCVD(times, ind),
      depth: () => this._rDepth(times),
    };
    if (dispatch[tabId]) dispatch[tabId]();
  }

  // Order-book depth as an indicator pane. Unlike every other tab this data
  // does not come from /api/data/<tf> — it is a 1 Hz series from the
  // backend's own order-book tracker, so it has to be bucketed onto the
  // chart's bar times before it can share the pane's time axis.
  _rDepth(times) {
    if (!times.length) return;
    const token = (this._depthToken = (this._depthToken || 0) + 1);

    const draw = hist => {
      // The fetch may land after the user has moved to another tab; without
      // this the series would be added to whatever pane is showing now.
      if (token !== this._depthToken || this.activeTab !== 'depth') return;

      const step = times.length > 1 ? times[1] - times[0] : 300;
      const first = times[0], last = times[times.length - 1] + step;
      const idxOf = new Map(times.map((t, i) => [t, i]));

      // sum + count per bar per band, averaged after — a bar spans many
      // samples and the resting depth within it is a level, not a total.
      const acc = DEPTH_BANDS.map(() => ({ bid: times.map(() => null), ask: times.map(() => null),
                                           bn: times.map(() => 0), an: times.map(() => 0) }));
      let covered = 0;
      for (const p of hist) {
        if (p.time < first || p.time >= last) continue;
        const bt = first + Math.floor((p.time - first) / step) * step;
        const i = idxOf.get(bt);
        if (i === undefined) continue;
        covered++;
        DEPTH_BANDS.forEach((b, k) => {
          const d = p.depths && (p.depths[b.pct] ?? p.depths[String(b.pct)]);
          if (!d) return;
          const a = acc[k];
          a.bid[i] = (a.bid[i] || 0) + d.bidVolume; a.bn[i]++;
          a.ask[i] = (a.ask[i] || 0) + d.askVolume; a.an[i]++;
        });
      }

      if (!covered) {
        this._depthNote('Стакан ещё не накопил истории на этом диапазоне — '
                      + 'трекер пишет с момента старта сервера.');
        return;
      }
      this._depthNote(null);

      DEPTH_BANDS.forEach((b, k) => {
        const a = acc[k];
        const bid = a.bid.map((v, i) => (a.bn[i] ? v / a.bn[i] : null));
        const ask = a.ask.map((v, i) => (a.an[i] ? v / a.an[i] : null));
        this._addLine(this._toPts(times, bid), b.bid, 2, `D${b.pct} bid`);
        this._addLine(this._toPts(times, ask), b.ask, 1, `D${b.pct} ask`);
      });
    };

    const fresh = Date.now() - DEPTH_CACHE.ts < DEPTH_CACHE_MS && DEPTH_CACHE.history.length;
    if (fresh) { draw(DEPTH_CACHE.history); return; }

    if (!DEPTH_CACHE.inflight) {
      DEPTH_CACHE.inflight = fetch(`${API}/depth/history?limit=86400`)
        .then(r => r.json())
        .then(d => {
          DEPTH_CACHE.history = Array.isArray(d.history) ? d.history : [];
          DEPTH_CACHE.ts = Date.now();
          return DEPTH_CACHE.history;
        })
        .catch(() => [])
        .finally(() => { DEPTH_CACHE.inflight = null; });
    }
    DEPTH_CACHE.inflight.then(draw);
  }

  _depthNote(text) {
    let el = document.getElementById('depth-pane-note');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'depth-pane-note';
      el.className = 'ind-pane-note';
      // .ind-chart-wrap is the positioned ancestor; its parent is not.
      this.indChartEl?.appendChild(el);
    }
    el.textContent = text;
  }

  _rWTMO(times, ind) {
    const s1 = this._addLine(this._toPts(times, ind.wt1), C.cyan, 2, 'WT1');
    this._addLine(this._toPts(times, ind.wt2), C.red, 1, 'WT2');
    this._hline(s1, 60, C.red, 'OB 60');
    this._hline(s1, -60, C.green, 'OS -60');
    this._hline(s1, 0, C.text);
  }

  _rMLMI(times, ind) {
    const sm = this._addLine(this._toPts(times, ind.mlmi), C.orange, 2, 'MLMI');
    this._addLine(this._toPts(times, ind.mlmi_ma), C.cyan, 1, 'MA');
    this._addLine(this._toPts(times, ind.mlmi_u_), C.red, 1, 'Upper');
    this._addLine(this._toPts(times, ind.mlmi_l_), C.green, 1, 'Lower');
    this._hline(sm, 0, C.text);
  }

  _rRSI(times, ind) {
    const s = this._addLine(this._toPts(times, ind.rsi), C.purple, 2, 'RSI');
    this._hline(s, 70, C.red, 'OB 70');
    this._hline(s, 30, C.green, 'OS 30');
    this._hline(s, 50, C.text);
  }

  _rMFI(times, ind) {
    const s = this._addLine(this._toPts(times, ind.mfi), C.yellow, 2, 'MFI');
    this._hline(s, 80, C.red, 'OB 80');
    this._hline(s, 20, C.green, 'OS 20');
  }

  _rCCI(times, ind) {
    const s = this._addLine(this._toPts(times, ind.cci), C.blue, 2, 'CCI');
    this._hline(s, 100, C.red, 'OB 100');
    this._hline(s, -100, C.green, 'OS -100');
    this._hline(s, 0, C.text);
  }

  _rWillR(times, ind) {
    const s = this._addLine(this._toPts(times, ind.willr), C.indigo, 2, 'W%R');
    this._hline(s, -20, C.red, 'OB -20');
    this._hline(s, -80, C.green, 'OS -80');
  }

  _rUO(times, ind) {
    const s = this._addLine(this._toPts(times, ind.uo), C.cyan, 2, 'UO');
    this._hline(s, 70, C.red, 'OB 70');
    this._hline(s, 30, C.green, 'OS 30');
    this._hline(s, 50, C.text);
  }

  // Colored like ADX.pine: +DI orange, -DI blue, ADX line green while
  // rising / red while falling (its color2), signal lines at 20 and 40.
  _rADX(times, ind) {
    const s1 = this._addLine(this._toPts(times, ind.dmp), C.orange, 2, '+DI');
    this._addLine(this._toPts(times, ind.dmm), C.blue, 2, '-DI');

    const adx = ind.adx;
    const adxColor = (v, i) => {
      const prev = i > 0 ? adx[i - 1] : null;
      if (v == null || prev == null) return C.up;
      return v > prev ? C.up : C.dn;
    };
    this._addColoredLine(times, adx, adxColor, 3, 'ADX');

    this._hline(s1, 40, C.white, 'Signal 40');
    this._hline(s1, 20, C.white, 'Signal 20');
  }

  _rCMF(times, ind) {
    const pts = this._toPts(times, ind.cmf, v => v >= 0 ? C.up : C.dn);
    const s = this._addHist(pts, 'CMF');
    this._hline(s, 0, C.text);
  }

  _rCVD(times, ind) {
    const s = this._addBaseline(this._toPts(times, ind.cvd), 'CVD');
    this._hline(s, 0, C.text);
  }
}

// ════════════════════════════════════════════════════════════════════
//  BinanceLiveFeed
// ════════════════════════════════════════════════════════════════════
class BinanceLiveFeed {
  constructor() {
    this.panel    = null;
    this.onPrice  = null;
    this.ws       = null;
    this.reconnectTimer = null;
  }

  setPanel(panel) { this.panel = panel; }
  setOnPrice(fn) { this.onPrice = fn; }

  connect() {
    if (this.ws) { try { this.ws.close(); } catch(_) {} }
    const s = ACTIVE_SYMBOL.toLowerCase();
    const stream = `${s}@kline_${ACTIVE_TF}/${s}@aggTrade`;
    const url = `wss://fstream.binance.com/stream?streams=${stream}`;

    try {
      this.ws = new WebSocket(url);
    } catch(e) {
      log('WS', `Error: ${e.message}`);
      return;
    }

    this.ws.onopen = () => {
      log('WS', `Connected (${ACTIVE_SYMBOL} ${ACTIVE_TF})`);
      const dot = document.getElementById('s-ws-dot');
      const txt = document.getElementById('s-ws-txt');
      if (dot) dot.className = 'dot';
      if (txt) txt.textContent = 'WS: live';
    };

    this.ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data);
        if (!msg.data) return;
        const d = msg.data;

        if (d.e === 'aggTrade') {
          const p = parseFloat(d.p);
          if (this.onPrice) this.onPrice(p);
          return;
        }

        if (d.e === 'kline') {
          const k = d.k;
          const candle = {
            time:      Math.floor(k.t / 1000),
            open:      parseFloat(k.o),
            high:      parseFloat(k.h),
            low:       parseFloat(k.l),
            close:     parseFloat(k.c),
            volume:    parseFloat(k.v),
            taker_buy: parseFloat(k.V || 0),
            closed:    k.x,
          };
          if (this.panel) this.panel.liveUpdate(candle);
        }
      } catch(_) {}
    };

    this.ws.onclose = () => {
      const dot = document.getElementById('s-ws-dot');
      const txt = document.getElementById('s-ws-txt');
      if (dot) dot.className = 'dot err';
      if (txt) txt.textContent = 'WS: disconnected';
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch(_) {} }
  }
}

// ════════════════════════════════════════════════════════════════════
//  CorrelationWidget
// ════════════════════════════════════════════════════════════════════
class CorrelationWidget {
  constructor() {
    this.listEl = document.getElementById('corr-list');
    this.tsEl   = document.getElementById('corr-ts');
    this._busy  = false;
  }

  async refresh() {
    if (this._busy) return;
    this._busy = true;
    if (this.listEl)
      this.listEl.innerHTML = '<div class="corr-loading"><div class="spinner-sm"></div> Загружаем корреляции…</div>';
    try {
      const resp = await fetch(`${API}/correlations`, { signal: AbortSignal.timeout(45000) });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      this._render(data);
    } catch (e) {
      if (this.listEl)
        this.listEl.innerHTML = `<div class="corr-loading corr-err">⚠ ${e.message}</div>`;
    } finally {
      this._busy = false;
    }
  }

  _render(data) {
    if (!this.listEl || !data.top10) return;
    const fmtPrice = p => p >= 1
      ? p.toLocaleString('en-US', { maximumFractionDigits: 2 })
      : p.toFixed(5);

    this.listEl.innerHTML = data.top10.map((item, i) => {
      const cls   = item.correlation > 0.85 ? 'high' : item.correlation > 0.65 ? 'med' : 'low';
      const chgCls= item.change_24h >= 0 ? 'up' : 'dn';
      const barW  = Math.max(0, Math.min(100, item.correlation * 100)).toFixed(1);
      const chgStr= `${item.change_24h >= 0 ? '+' : ''}${item.change_24h.toFixed(2)}%`;
      const sym   = item.full_symbol || `${item.symbol}USDT`;
      const active= sym === ACTIVE_SYMBOL ? ' active' : '';
      return `
      <div class="corr-item${active}" data-symbol="${sym}" role="button" tabindex="0"
           title="Показать ${item.symbol} на дашборде">
        <span class="corr-rank">#${i+1}</span>
        <span class="corr-sym">${item.symbol}</span>
        <span class="corr-bar-wrap"><span class="corr-bar" style="width:${barW}%"></span></span>
        <span class="corr-val ${cls}">${item.correlation.toFixed(3)}</span>
        <span class="corr-chg ${chgCls}">${chgStr}</span>
        <span class="corr-price">$${fmtPrice(item.price)}</span>
      </div>`;
    }).join('');

    this.listEl.querySelectorAll('.corr-item').forEach(el => {
      const go = () => window.dashboard?.setSymbol(el.dataset.symbol);
      el.addEventListener('click', go);
      el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    if (this.tsEl && data.ts) {
      const d = new Date(data.ts * 1000);
      this.tsEl.textContent = `Обновлено: ${d.toLocaleTimeString()} · TTL: ${Math.round(data.ttl/60)} мин`;
    }
  }

  markActive(symbol) {
    this.listEl?.querySelectorAll('.corr-item').forEach(el =>
      el.classList.toggle('active', el.dataset.symbol === symbol));
  }
}

// ════════════════════════════════════════════════════════════════════
//  Dashboard
// ════════════════════════════════════════════════════════════════════
class Dashboard {
  constructor() {
    this.panel     = new ChartPanel();
    this.liveFeed  = new BinanceLiveFeed();
    this.corrWidget= new CorrelationWidget();
    this.prevPrice = null;
    this.refreshIn = 30;
    this._switching= false;
  }

  async init() {
    this._bindTFButtons();

    await this.loadAll();

    this.liveFeed.setPanel(this.panel);
    this.liveFeed.setOnPrice(p => this._updatePriceLive(p));
    this.liveFeed.connect();

    this.corrWidget.refresh();
    window.Zones?.load(ACTIVE_SYMBOL);
    this._updateSymbolLabels();

    setInterval(() => {
      this.refreshIn--;
      const el = document.getElementById('s-next');
      if (el) el.textContent = `${this.refreshIn}s`;
      if (this.refreshIn <= 0) { this.refreshIn = 30; this.loadAll(); }
    }, 1000);

    setInterval(() => this.corrWidget.refresh(), 5 * 60 * 1000);
    setInterval(() => window.Zones?.load(ACTIVE_SYMBOL), 5 * 60 * 1000);

    const _fmt = tz => new Date().toLocaleTimeString('en-GB',{
      timeZone:tz, hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
    });
    const _upd = () => {
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const g = id => document.getElementById(id);
      if(g('wc-local'))   g('wc-local').textContent   = _fmt(local);
      if(g('wc-lon'))     g('wc-lon').textContent     = _fmt('Europe/London');
      if(g('wc-bej'))     g('wc-bej').textContent     = _fmt('Asia/Shanghai');
      if(g('wc-nyc'))     g('wc-nyc').textContent     = _fmt('America/New_York');
      if(g('status-time'))g('status-time').textContent = _fmt(local).slice(0,5);
    };
    _upd(); setInterval(_upd, 1000);
  }

  _bindTFButtons() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tf = btn.dataset.tf;
        if (tf && tf !== ACTIVE_TF) {
          this.setTF(tf);
        }
      });
    });
  }

  async setTF(tf) {
    if (!ALL_TFS.includes(tf)) return;
    ACTIVE_TF = tf;

    // Highlight active button
    document.querySelectorAll('.tf-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tf === tf);
    });

    const disp = document.getElementById('panel-tf-display');
    if (disp) disp.textContent = tf;

    this.liveFeed.disconnect();
    await this.panel.load(tf);
    this.liveFeed.connect();
    window.Zones?.redraw();
  }

  async loadAll() {
    this._spinning(true);

    // Load active TF for the main chart
    const p1 = this.panel.load(ACTIVE_TF);

    // Load all TFs in parallel to fill the indicator summary table
    const p2 = Promise.allSettled(ALL_TFS.map(async tf => {
      try {
        const resp = await fetch(`${API}/data/${tf}?symbol=${ACTIVE_SYMBOL}`);
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.indicators && data.ohlcv?.length) {
          TF_CACHE[tf] = data;                 // retained for crosshair lookups
          updateTableRow(tf, data.indicators, data.ohlcv.length - 1);
        }
      } catch(_) {}
    }));

    await Promise.all([p1, p2]);
    this._spinning(false);
    this.refreshIn = 30;
    this._setStatus(true);
    window.Zones?.redraw();
  }

  _updatePriceLive(price) {
    if (price == null || price === 0) return;
    const el = document.getElementById('hdr-price');
    const chgEl = document.getElementById('hdr-change');
    if (!el) return;

    el.textContent = `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

    if (this.prevPrice !== null) {
      const diff = price - this.prevPrice;
      const pct = (diff / this.prevPrice * 100).toFixed(2);
      if (chgEl) {
        chgEl.textContent = `${diff >= 0 ? '+' : ''}${pct}%`;
        chgEl.className = `price-change ${diff >= 0 ? 'up' : 'dn'}`;
      }
      el.style.color = diff >= 0 ? 'var(--green)' : 'var(--red)';
      setTimeout(() => { el.style.color = ''; }, 800);
    }
    this.prevPrice = price;
  }

  _spinning(on) { document.getElementById('btn-refresh')?.classList.toggle('spinning', on); }

  _setStatus(ok) {
    const s = (id, cls, txt) => {
      const d = document.getElementById(id+'dot'); const t = document.getElementById(id+'txt');
      if(d) d.className = cls; if(t) t.textContent = txt;
    };
    s('s-api-', ok ? 'dot' : 'dot err', ok ? 'REST: ok' : 'REST: error');
    s('s-data-', ok ? 'dot' : 'dot warn', ok ? `Data: ${ACTIVE_SYMBOL}` : 'Data: stale');
  }

  async setSymbol(symbol) {
    if (!symbol || symbol === ACTIVE_SYMBOL || this._switching) return;
    this._switching = true;
    ACTIVE_SYMBOL = symbol;
    this.prevPrice = null;
    this.corrWidget.markActive(symbol);
    this._updateSymbolLabels();
    try {
      this.liveFeed.disconnect();
      await this.loadAll();
      this.liveFeed.connect();
      window.Zones?.load(symbol);
    } finally {
      this._switching = false;
    }
  }

  _updateSymbolLabels() {
    const base = ACTIVE_SYMBOL.replace('USDT', '');
    const inst = document.getElementById('panel-instrument');
    if (inst) inst.textContent = `${ACTIVE_SYMBOL} PERP`;
    const sym = document.getElementById('hdr-sym');
    if (sym) sym.textContent = `${ACTIVE_SYMBOL} · PERP`;
    document.title = `CryptoDATEX · ${base} Dashboard · Binance Futures`;
  }

  refreshAll()  { this.refreshIn = 30; this.loadAll(); }
  refreshCorr() { this.corrWidget.refresh(); }
}

function log(tag, msg) { console.log(`[${tag}] ${msg}`); }

function initPageLinks() {
  const links = document.querySelectorAll('.page-link');
  links.forEach(link => {
    link.addEventListener('click', e => {
      const path = link.getAttribute('data-path');
      if (path && path !== window.location.pathname) {
        e.preventDefault();
        window.location.href = path;
      }
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initPageLinks();
  const dash = new Dashboard();
  window.dashboard = dash;
  await dash.init();
});
