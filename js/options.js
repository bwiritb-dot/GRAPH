/**
 * CryptoDATEX — Options Analyzer (Deribit Range analyzer integration)
 */
'use strict';

const OPTIONS_API = `${getAppBaseUrl()}/api/options`;

const C = {
  bg:'#12121a',
  grid:'rgba(255,255,255,0.035)',
  text:'#555570',
  border:'rgba(255,255,255,0.055)',
  white:'rgba(230,230,245,0.88)',
  whiteDim:'rgba(230,230,245,0.35)',
  orange:'#f7931a',
  blue:'#00d4ff',
  cyan:'#31ffc8',
  gold:'#fbbf24',
  red:'#ef5350',
  redDim:'rgba(239,83,80,0.45)',
  green:'#26a69a',
  greenDim:'rgba(38,166,154,0.45)',
};

function getAppBaseUrl() {
  return window.location.protocol === 'file:'
    ? 'http://127.0.0.1:5050'
    : window.location.origin;
}

function getPageHref(path) {
  const baseUrl = getAppBaseUrl();
  return path === '/' ? `${baseUrl}/` : `${baseUrl}${path}`;
}

function initPageLinks() {
  document.querySelectorAll('.page-link[data-path]').forEach(link => {
    const path = link.dataset.path || '/';
    link.href = getPageHref(path);
  });
}

function chartOpts(w, h) {
  return {
    width:w,
    height:h,
    layout:{
      background:{ type:'solid', color:C.bg },
      textColor:C.text,
      fontFamily:"'JetBrains Mono',monospace",
      fontSize:9,
    },
    grid:{
      vertLines:{ color:C.grid },
      horzLines:{ color:C.grid },
    },
    crosshair:{
      mode:LightweightCharts.CrosshairMode.Normal,
      vertLine:{ color:'rgba(255,255,255,0.12)', style:0, labelBackgroundColor:'#1e1e30' },
      horzLine:{ color:'rgba(255,255,255,0.12)', style:0, labelBackgroundColor:'#1e1e30' },
    },
    rightPriceScale:{
      borderColor:C.border,
      textColor:C.text,
      scaleMargins:{ top:0.08, bottom:0.08 },
      minimumWidth:68,
    },
    timeScale:{
      borderColor:C.border,
      timeVisible:true,
      secondsVisible:false,
      lockVisibleTimeRangeOnResize:true,
    },
    handleScroll:{ mouseWheel:true, pressedMouseMove:true },
    handleScale:{ mouseWheel:true, pinch:true },
  };
}

function fmtMoney(value, digits=2) {
  return value == null || Number.isNaN(+value)
    ? '—'
    : `$${(+value).toLocaleString('en-US', { minimumFractionDigits:digits, maximumFractionDigits:digits })}`;
}

function fmtPlain(value, digits=1) {
  return value == null || Number.isNaN(+value)
    ? '—'
    : (+value).toLocaleString('en-US', { minimumFractionDigits:digits, maximumFractionDigits:digits });
}

function fmtPercent(value, digits=2) {
  return value == null || Number.isNaN(+value) ? '—' : `${(+value).toFixed(digits)}%`;
}

function fmtRange(range) {
  if (!range) return '—';
  return `${fmtMoney(range.low)} → ${fmtMoney(range.high)}`;
}

function fmtDateTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('en-GB', {
      year:'numeric',
      month:'short',
      day:'2-digit',
      hour:'2-digit',
      minute:'2-digit',
      hour12:false,
    });
  } catch (_) {
    return value;
  }
}

class OptionsDashboard {
  constructor() {
    this.chart = null;
    this.series = {};
    this.payload = null;
    this.data = [];
    this.selectedIndex = 0;
    this.refreshIn = 60;
    this.timeToIdx = new Map();
    this._busy = false;
    this._countdownTimer = null;
    this._resizeObserver = null;
    this._clockTimer = null;
  }

  async init() {
    this._buildChart();
    this._bindTable();
    this._setupClocks();
    await this.refreshAll();
    this._countdownTimer = setInterval(() => {
      this.refreshIn--;
      const el = document.getElementById('s-next');
      if (el) el.textContent = `${this.refreshIn}s`;
      if (this.refreshIn <= 0) {
        this.refreshIn = 60;
        this.refreshAll();
      }
    }, 1000);
  }

  _buildChart() {
    const chartEl = document.getElementById('options-chart');
    this.chart = LightweightCharts.createChart(
      chartEl,
      chartOpts(chartEl.clientWidth, chartEl.clientHeight || 360)
    );

    const line = (opts) => this.chart.addLineSeries({
      priceFormat:{ type:'price', precision:2, minMove:0.01 },
      crosshairMarkerVisible:false,
      lastValueVisible:true,
      priceLineVisible:false,
      ...opts,
    });

    this.series.sigma2Low = line({ color:'rgba(239,83,80,0.35)', lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, title:'2σ Low' });
    this.series.sigma1Low = line({ color:C.gold, lineWidth:1, title:'1σ Low' });
    this.series.futures = line({ color:C.white, lineWidth:2, title:'Futures' });
    this.series.sigma1High = line({ color:C.orange, lineWidth:1, title:'1σ High' });
    this.series.sigma2High = line({ color:C.blue, lineWidth:1, lineStyle:LightweightCharts.LineStyle.Dashed, title:'2σ High' });

    this.chart.subscribeCrosshairMove(param => {
      if (!param?.time) return;
      const idx = this.timeToIdx.get(Number(param.time));
      if (idx !== undefined) this.selectIndex(idx);
    });

    this._resizeObserver = new ResizeObserver(() => {
      if (!this.chart || chartEl.clientWidth <= 0 || chartEl.clientHeight <= 0) return;
      this.chart.resize(chartEl.clientWidth, chartEl.clientHeight);
    });
    this._resizeObserver.observe(chartEl);
  }

  _bindTable() {
    const tbody = document.getElementById('options-table-body');
    tbody?.addEventListener('click', event => {
      const row = event.target.closest('tr[data-idx]');
      if (!row) return;
      const idx = Number(row.dataset.idx);
      if (!Number.isNaN(idx)) this.selectIndex(idx);
    });
  }

  async refreshAll() {
    if (this._busy) return;
    this._busy = true;
    this._spinning(true);
    document.getElementById('loading-options-chart')?.classList.remove('hidden');

    try {
      const resp = await fetch(`${OPTIONS_API}/ranges`, { signal:AbortSignal.timeout(20000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const payload = await resp.json();
      if (!payload.ok || !payload.data) throw new Error(payload.error || 'Deribit payload error');

      this.payload = payload;
      this.data = (payload.data.expirations || []).map(exp => ({
        ...exp,
        time:Math.floor(exp.expiry_timestamp / 1000),
      }));
      this.timeToIdx = new Map(this.data.map((item, idx) => [item.time, idx]));

      this._renderHeader(payload.data.eth_index_price);
      this._renderMetrics();
      this._renderChart();
      this._renderTable();
      this.selectIndex(Math.min(this.selectedIndex, Math.max(this.data.length - 1, 0)));
      this._setStatus(true, !!payload.stale, payload.warning || null);

      const ts = document.getElementById('options-ts');
      if (ts) ts.textContent = `Snapshot ${fmtDateTime(payload.data.generated_at)}`;

      const generated = document.getElementById('options-generated-at');
      if (generated) {
        generated.textContent = `Generated: ${fmtDateTime(payload.data.generated_at)} · ${payload.stale ? 'stale snapshot fallback' : 'live Deribit fetch'}`;
      }
    } catch (err) {
      console.error('[options]', err);
      this._setTableError(err.message);
      this._setStatus(false, false, err.message);
    } finally {
      this.refreshIn = 60;
      this._busy = false;
      this._spinning(false);
      document.getElementById('loading-options-chart')?.classList.add('hidden');
    }
  }

  _renderHeader(indexPrice) {
    const priceEl = document.getElementById('hdr-price');
    const changeEl = document.getElementById('hdr-change');
    if (priceEl) priceEl.textContent = fmtMoney(indexPrice);
    if (changeEl) {
      const front = this.data[0];
      changeEl.className = 'price-change up';
      changeEl.textContent = front ? `Front IV ${fmtPercent(front.atm_iv_pct)}` : '';
    }
  }

  _renderMetrics() {
    if (!this.data.length || !this.payload?.data) return;
    const front = this.data[0];
    const avgSigma1 = this.data.reduce((sum, item) => sum + item.sigma1.range, 0) / this.data.length;
    const widestSigma2 = this.data.reduce((max, item) => item.sigma2.range > max.sigma2.range ? item : max, this.data[0]);

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    set('metric-index', fmtMoney(this.payload.data.eth_index_price));
    set('metric-index-subtle', `${this.data.length} live expiries tracked`);
    set('metric-front-expiry', front.expiry);
    set('metric-front-dte', `${fmtPlain(front.days_to_expiry, 1)} days to expiry`);
    set('metric-front-iv', fmtPercent(front.atm_iv_pct));
    set('metric-front-strike', `ATM strike ${fmtPlain(front.atm_strike, 0)}`);
    set('metric-avg-s1', fmtMoney(avgSigma1));
    set('metric-wide-s2', `${widestSigma2.expiry} · ${fmtMoney(widestSigma2.sigma2.range)}`);
  }

  _renderChart() {
    if (!this.chart || !this.data.length) return;
    const mapSeries = fn => this.data.map(fn);

    this.series.sigma2Low.setData(mapSeries(item => ({ time:item.time, value:item.sigma2.low })));
    this.series.sigma1Low.setData(mapSeries(item => ({ time:item.time, value:item.sigma1.low })));
    this.series.futures.setData(mapSeries(item => ({ time:item.time, value:item.futures_price })));
    this.series.sigma1High.setData(mapSeries(item => ({ time:item.time, value:item.sigma1.high })));
    this.series.sigma2High.setData(mapSeries(item => ({ time:item.time, value:item.sigma2.high })));
    this.chart.timeScale().fitContent();
  }

  _renderTable() {
    const tbody = document.getElementById('options-table-body');
    if (!tbody) return;
    if (!this.data.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="options-empty">No upcoming ETH option expiries were returned.</td></tr>';
      return;
    }

    tbody.innerHTML = this.data.map((item, idx) => `
      <tr data-idx="${idx}" class="${idx === this.selectedIndex ? 'active' : ''}">
        <td>${item.expiry}</td>
        <td>${fmtPlain(item.days_to_expiry, 1)}</td>
        <td>${fmtPercent(item.atm_iv_pct)}</td>
        <td>${fmtMoney(item.futures_price)}</td>
        <td>${fmtMoney(item.sigma1.low)}</td>
        <td>${fmtMoney(item.sigma1.high)}</td>
        <td>${fmtMoney(item.sigma2.low)}</td>
        <td>${fmtMoney(item.sigma2.high)}</td>
        <td>${fmtMoney(item.sigma2.range)}</td>
      </tr>
    `).join('');
  }

  selectIndex(idx) {
    if (!this.data.length) return;
    this.selectedIndex = Math.max(0, Math.min(idx, this.data.length - 1));
    const selected = this.data[this.selectedIndex];
    if (!selected) return;

    document.querySelectorAll('#options-table-body tr[data-idx]').forEach(row => {
      row.classList.toggle('active', Number(row.dataset.idx) === this.selectedIndex);
    });

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    set('opt-expiry', selected.expiry);
    set('opt-dte', `${fmtPlain(selected.days_to_expiry, 1)}d`);
    set('opt-s1', fmtMoney(selected.sigma1.range));
    set('opt-s2', fmtMoney(selected.sigma2.range));

    set('selected-expiry-label', `${selected.expiry} · ${fmtPlain(selected.days_to_expiry, 1)}d`);
    set('detail-futures', fmtMoney(selected.futures_price));
    set('detail-strike', fmtPlain(selected.atm_strike, 0));
    set('detail-sigma1', fmtRange(selected.sigma1));
    set('detail-sigma2', fmtRange(selected.sigma2));
    set('detail-sigma1-width', fmtMoney(selected.sigma1.range));
    set('detail-sigma2-width', fmtMoney(selected.sigma2.range));
  }

  _setStatus(ok, stale, warning) {
    const set = (prefix, dotClass, text) => {
      const dot = document.getElementById(`${prefix}-dot`);
      const label = document.getElementById(`${prefix}-txt`);
      if (dot) dot.className = dotClass;
      if (label) label.textContent = text;
    };

    set('s-api', ok ? 'dot' : 'dot err', ok ? 'REST: ok' : 'REST: error');
    set('s-ws', stale ? 'dot warn' : 'dot', stale ? 'Feed: saved snapshot' : 'Feed: live snapshot');
    set('s-data', ok ? (stale ? 'dot warn' : 'dot') : 'dot err', ok ? (stale ? 'Data: stale fallback' : 'Data: ETH options') : 'Data: unavailable');

    const warningEl = document.getElementById('options-warning');
    if (warningEl) {
      warningEl.textContent = warning || 'Click an expiry row or hover the chart to inspect a specific range window.';
      warningEl.classList.toggle('is-warning', !!warning);
    }
  }

  _setTableError(message) {
    const tbody = document.getElementById('options-table-body');
    const help = 'Start start.bat or run .venv\\Scripts\\python.exe server.py.';
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="9" class="options-empty">Deribit options load failed: ${message}. ${help}</td></tr>`;
    }
    const warningEl = document.getElementById('options-warning');
    if (warningEl) {
      warningEl.textContent = `${message}. ${help}`;
      warningEl.classList.add('is-warning');
    }
  }

  _spinning(on) {
    document.getElementById('btn-refresh')?.classList.toggle('spinning', on);
  }

  _setupClocks() {
    const fmt = tz => new Date().toLocaleTimeString('en-GB', {
      timeZone:tz,
      hour:'2-digit',
      minute:'2-digit',
      second:'2-digit',
      hour12:false,
    });

    const update = () => {
      const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const set = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
      };
      set('wc-local', fmt(local));
      set('wc-lon', fmt('Europe/London'));
      set('wc-bej', fmt('Asia/Shanghai'));
      set('wc-nyc', fmt('America/New_York'));
      set('status-time', fmt(local).slice(0, 5));
    };

    update();
    this._clockTimer = setInterval(update, 1000);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initPageLinks();
  const dash = new OptionsDashboard();
  window.optionsDashboard = dash;
  await dash.init();
});
