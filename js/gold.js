/**
 * CryptoDATEX — Gold page (PAXG/USDT proxy for XAUUSD)
 * Single chart: candles + LRC(84) + MA Cross(9,26) + Parabolic SAR(0.02,0.02,0.2)
 * overlaid on price, plus UO(7,14,28) and Linear Regression Slope(7) sub-panes.
 * Timeframes: 15m / 1H / 4H only.
 */
'use strict';

function getAppBaseUrl() {
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') return 'http://127.0.0.1:5050';
  return (typeof window !== 'undefined' && window.location.origin) ? window.location.origin : 'http://127.0.0.1:5050';
}

const API = `${getAppBaseUrl()}/api`;
const GOLD_SYMBOL = 'PAXGUSDT';
const GOLD_TFS = ['15m', '1h', '4h'];
let ACTIVE_TF = '15m';

const PRICE_SCALE_WIDTH = 82;

const C = {
  bg:'#12121a', grid:'rgba(255,255,255,0.035)', text:'#555570',
  border:'rgba(255,255,255,0.055)',
  up:'#26a69a', dn:'#ef5350',
  white:'rgba(230,230,245,0.92)',
  green:'#00e676', pink:'#ff4fd8',
  lrcMid:'#00d4ff', lrcBand:'rgba(0,212,255,0.45)',
  sar:'rgba(255,255,255,0.95)',
  uo:'#31ffc8', slope:'#ef5350',
  orange:'#f7931a',
};

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
class GoldPanel {
  constructor() {
    this.tf = ACTIVE_TF;
    this.data = null;
    this._timeToIdx = new Map();

    this.mainEl  = document.getElementById('gold-chart');
    this.uoEl    = document.getElementById('gold-uo-pane');
    this.slopeEl = document.getElementById('gold-slope-pane');
    this.infoOverlayEl = document.getElementById('gold-info-overlay');

    this._buildUI();
  }

  _buildUI() {
    if (!this.mainEl) return;

    this.mainChart = LightweightCharts.createChart(this.mainEl, {
      layout: { background: { color: C.bg }, textColor: C.text },
      grid:   { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTickMarkFormatter },
      rightPriceScale: { borderColor: C.border, autoScale: true, minimumWidth: PRICE_SCALE_WIDTH, scaleMargins: { top: 0.05, bottom: 0.05 } },
      handleScale: { axisPressedMouseMove: { time: true, price: true } },
    });

    this.candleSeries = this.mainChart.addCandlestickSeries({
      upColor: C.up, downColor: C.dn,
      borderUpColor: C.up, borderDownColor: C.dn,
      wickUpColor: C.up, wickDownColor: C.dn,
    });

    // LRC(84): basis + upper/lower bands
    this.lrcMidSeries = this.mainChart.addLineSeries({
      color: C.lrcMid, lineWidth: 2, title: 'LRC 84',
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });
    this.lrcUpSeries = this.mainChart.addLineSeries({
      color: C.lrcBand, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.lrcDnSeries = this.mainChart.addLineSeries({
      color: C.lrcBand, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    // MA Cross 9 / 26
    this.maFastSeries = this.mainChart.addLineSeries({
      color: C.green, lineWidth: 1, title: 'MA 9',
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    this.maSlowSeries = this.mainChart.addLineSeries({
      color: C.pink, lineWidth: 1, title: 'MA 26',
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    // Parabolic SAR — rendered as dots (no connecting line)
    this.sarSeries = this.mainChart.addLineSeries({
      color: C.sar, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 2,
      title: 'SAR', priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });

    // UO sub-pane
    this.uoChart = LightweightCharts.createChart(this.uoEl, {
      layout: { background: { color: C.bg }, textColor: C.text },
      grid:   { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTickMarkFormatter },
      rightPriceScale: { borderColor: C.border, autoScale: true, minimumWidth: PRICE_SCALE_WIDTH },
    });
    this.uoSeries = this.uoChart.addLineSeries({
      color: C.uo, lineWidth: 2, title: 'UO', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });
    this.uoSeries.createPriceLine({ price: 70, color: C.dn, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '70' });
    this.uoSeries.createPriceLine({ price: 60, color: C.up, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '60' });
    this.uoSeries.createPriceLine({ price: 40, color: C.up, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '40' });
    this.uoSeries.createPriceLine({ price: 30, color: C.orange, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '30' });

    // Linear Regression Slope sub-pane
    this.slopeChart = LightweightCharts.createChart(this.slopeEl, {
      layout: { background: { color: C.bg }, textColor: C.text },
      grid:   { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      localization: { timeFormatter: localTimeFormatter },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: localTickMarkFormatter },
      rightPriceScale: { borderColor: C.border, autoScale: true, minimumWidth: PRICE_SCALE_WIDTH },
    });
    this.slopeSeries = this.slopeChart.addLineSeries({
      color: C.slope, lineWidth: 2, title: 'LinReg Slope', priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });
    this.slopeSeries.createPriceLine({ price: 0, color: C.text, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: false });

    this._syncTimeScales();
  }

  _syncTimeScales() {
    const charts = [this.mainChart, this.uoChart, this.slopeChart];
    let guard = false;
    charts.forEach((chart, i) => {
      chart.timeScale().subscribeVisibleLogicalRangeChange(r => {
        if (guard || !r) return;
        guard = true;
        charts.forEach((c, j) => { if (j !== i) { try { c.timeScale().setVisibleLogicalRange(r); } catch(_) {} } });
        guard = false;
      });
    });

    let suppress = false;
    const crosshairHandler = srcChart => param => {
      if (suppress) return;
      suppress = true;
      if (!param?.time || !param.point) {
        charts.forEach(c => { if (c !== srcChart) { try { c.clearCrosshairPosition(); } catch(_) {} } });
      } else {
        const idx = this._timeToIdx.get(param.time);
        if (idx !== undefined) this._updateOHLCVRaw(this.data?.ohlcv?.[idx]);
        if (srcChart !== this.mainChart && this.candleSeries) {
          const row = idx !== undefined ? this.data?.ohlcv?.[idx] : null;
          if (row) { try { this.mainChart.setCrosshairPosition(row.close, param.time, this.candleSeries); } catch(_) {} }
        }
        if (srcChart !== this.uoChart && this.uoSeries) {
          const v = idx !== undefined ? this.data?.indicators?.uo?.[idx] : null;
          if (v != null) { try { this.uoChart.setCrosshairPosition(v, param.time, this.uoSeries); } catch(_) {} }
        }
        if (srcChart !== this.slopeChart && this.slopeSeries) {
          const v = idx !== undefined ? this.data?.indicators?.linreg_slope?.[idx] : null;
          if (v != null) { try { this.slopeChart.setCrosshairPosition(v, param.time, this.slopeSeries); } catch(_) {} }
        }
      }
      suppress = false;
    };
    charts.forEach(c => c.subscribeCrosshairMove(crosshairHandler(c)));
  }

  async load(tf) {
    if (tf) this.tf = tf;
    document.getElementById('loading-gold')?.classList.remove('hidden');
    try {
      const resp = await fetch(`${API}/gold/${this.tf}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      this.data = data;
      const ohlcv = data.ohlcv;
      this._timeToIdx = new Map(ohlcv.map((d, i) => [d.time, i]));

      this.candleSeries.setData(ohlcv.map(d => ({ time: d.time, open: d.open, high: d.high, low: d.low, close: d.close })));
      this._renderOverlays();
      this.mainChart.timeScale().fitContent();
      this._updateOHLCVRaw(ohlcv[ohlcv.length - 1]);

      document.getElementById('loading-gold')?.classList.add('hidden');
      return true;
    } catch (err) {
      console.error(`[gold:${this.tf}]`, err);
      document.getElementById('loading-gold')?.classList.add('hidden');
      return false;
    }
  }

  _toPts(times, vals) {
    const out = [];
    if (!vals || !times) return out;
    for (let i = 0; i < times.length; i++) {
      const v = vals[i];
      if (v === null || v === undefined || Number.isNaN(v)) { out.push({ time: times[i] }); continue; }
      out.push({ time: times[i], value: +v });
    }
    return out;
  }

  _renderOverlays() {
    if (!this.data?.ohlcv) return;
    const { ohlcv, indicators: ind } = this.data;
    const times = ohlcv.map(d => d.time);

    this.lrcMidSeries.setData(this._toPts(times, ind.lrc_mid));
    this.lrcUpSeries.setData(this._toPts(times, ind.lrc_upper));
    this.lrcDnSeries.setData(this._toPts(times, ind.lrc_lower));
    this.maFastSeries.setData(this._toPts(times, ind.ma_fast));
    this.maSlowSeries.setData(this._toPts(times, ind.ma_slow));
    this.sarSeries.setData(this._toPts(times, ind.sar));

    this.uoSeries.setData(this._toPts(times, ind.uo));
    this.slopeSeries.setData(this._toPts(times, ind.linreg_slope));
  }

  _updateOHLCVRaw(d) {
    if (!d) return;
    const fmt = v => v != null ? (+v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
    const g = id => document.getElementById(id);
    if (g('o-gold')) g('o-gold').textContent = fmt(d.open);
    if (g('h-gold')) g('h-gold').textContent = fmt(d.high);
    if (g('l-gold')) g('l-gold').textContent = fmt(d.low);
    if (g('c-gold')) g('c-gold').textContent = fmt(d.close);
  }

  liveUpdate(candle) {
    if (!this.candleSeries) return;
    this.candleSeries.update({ time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close });
    this._updateOHLCVRaw(candle);
    if (candle.closed) this.load(this.tf);
  }
}

// ════════════════════════════════════════════════════════════════════
class GoldLiveFeed {
  constructor() { this.panel = null; this.ws = null; this.reconnectTimer = null; }
  setPanel(p) { this.panel = p; }

  connect() {
    if (this.ws) { try { this.ws.close(); } catch(_) {} }
    const s = GOLD_SYMBOL.toLowerCase();
    const url = `wss://fstream.binance.com/stream?streams=${s}@kline_${ACTIVE_TF}`;
    try { this.ws = new WebSocket(url); } catch(e) { return; }

    this.ws.onopen = () => {
      const dot = document.getElementById('s-ws-dot');
      const txt = document.getElementById('s-ws-txt');
      if (dot) dot.className = 'dot';
      if (txt) txt.textContent = 'WS: live';
    };
    this.ws.onmessage = evt => {
      try {
        const msg = JSON.parse(evt.data);
        const d = msg.data;
        if (d?.e === 'kline') {
          const k = d.k;
          this.panel?.liveUpdate({
            time: Math.floor(k.t / 1000),
            open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c),
            closed: k.x,
          });
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
class GoldDashboard {
  constructor() {
    this.panel = new GoldPanel();
    this.liveFeed = new GoldLiveFeed();
    this.refreshIn = 30;
  }

  async init() {
    this._bindTFButtons();
    await this.panel.load(ACTIVE_TF);
    this.liveFeed.setPanel(this.panel);
    this.liveFeed.connect();
    this._setStatus(true);

    setInterval(() => {
      this.refreshIn--;
      const el = document.getElementById('s-next');
      if (el) el.textContent = `${this.refreshIn}s`;
      if (this.refreshIn <= 0) { this.refreshIn = 30; this.panel.load(ACTIVE_TF); }
    }, 1000);

    const _fmt = tz => new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const _upd = () => {
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const g = id => document.getElementById(id);
      if (g('wc-local')) g('wc-local').textContent = _fmt(local);
      if (g('wc-lon'))   g('wc-lon').textContent   = _fmt('Europe/London');
      if (g('wc-bej'))   g('wc-bej').textContent   = _fmt('Asia/Shanghai');
      if (g('wc-nyc'))   g('wc-nyc').textContent   = _fmt('America/New_York');
      if (g('status-time')) g('status-time').textContent = _fmt(local).slice(0, 5);
    };
    _upd(); setInterval(_upd, 1000);
  }

  _bindTFButtons() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const tf = btn.dataset.tf;
        if (tf && GOLD_TFS.includes(tf) && tf !== ACTIVE_TF) this.setTF(tf);
      });
    });
  }

  async setTF(tf) {
    if (!GOLD_TFS.includes(tf)) return;
    ACTIVE_TF = tf;
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.toggle('active', b.dataset.tf === tf));
    const disp = document.getElementById('panel-tf-display');
    if (disp) disp.textContent = tf;
    this.liveFeed.disconnect();
    await this.panel.load(tf);
    this.liveFeed.connect();
  }

  refreshAll() { this.refreshIn = 30; this.panel.load(ACTIVE_TF); }

  _setStatus(ok) {
    const d = document.getElementById('s-api-dot'), t = document.getElementById('s-api-txt');
    if (d) d.className = ok ? 'dot' : 'dot err';
    if (t) t.textContent = ok ? 'REST: ok' : 'REST: error';
  }
}

function initPageLinks() {
  document.querySelectorAll('.page-link').forEach(link => {
    link.addEventListener('click', e => {
      const path = link.getAttribute('data-path');
      if (path && path !== window.location.pathname) { e.preventDefault(); window.location.href = path; }
    });
  });
}

window.addEventListener('DOMContentLoaded', async () => {
  initPageLinks();
  const dash = new GoldDashboard();
  window.goldDashboard = dash;
  await dash.init();
});
