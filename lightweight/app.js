// Global variables
//
// Order-book depth is tracked server-side (see DepthTracker in server.py) so
// it keeps accumulating whether or not this page is open. This page just
// polls /api/depth/history and renders whatever the backend has collected —
// it no longer opens its own Binance WebSocket for depth.
let chart = null;
let depthSeries = {};
let priceSeries = null;
let fpUpSeries = null;
let fpDownSeries = null;
let updateCount = 0;
let rawDepthHistory = [];
let aggregatedHistory = [];
const MAX_RAW_HISTORY = 60 * 60 * 24;
let depthPollInterval = null;
let historicalRefreshInterval = null;
let lastMarkerTime = 0;
let currentSymbol = '';
let currentTimeframe = 0;
let crossoverCount = 0;
let currentTimezoneOffset = 0;
let maxPrice = 0;
let minPrice = Infinity;
let trackerStartedAt = null;
let trackerEarliestSample = null;
let prevHdrPrice = null;

// Footprint (directional volume) overlay state
let footprintMode = 'depth'; // 'depth' | 'traded' | 'off'
let fpMaxUp = 1;
let fpMaxDown = 1;
let fpTooltipDataDepth = new Map();  // time -> {price, total, perDepth, direction}
let fpTooltipDataTraded = new Map(); // time -> {buyVol, sellVol, totalVol, imbalance, direction}

// Variables for volume and traders
let volumeChart = null;
let volumeDeltaSeries = null;
let volumeHistogramSeries = null;
let volumeMASeries = null;
let volumeRollingDeltaSeries = null;
let volumeTrueCVDSeries = null;
let volumeDataHistory = [];
let volumeDataInterval = null;

// Per-source freshness tracking so a failed fetch is visibly distinguishable
// from a genuinely quiet market. See setDataStatus() / renderDataStatus().
const dataStatus = {
    depth:  { state: 'INIT', msg: '', ts: 0 },
    volume: { state: 'INIT', msg: '', ts: 0 },
    trader: { state: 'INIT', msg: '', ts: 0 }
};

let traderDataHistory = [];
let traderDataInterval = null;
let previousTraderData = null;

const BEEP_SOUND = 'data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTPB6fPOemshCCt9y/DdlkMLG2u57+OaTxwOUqXi79l1KAcjdsfx3JhVHhJqv+7w2nwvBUPF8PPUhDIBKHvU8eSxXxIKSZ3e8Nl+MwQldsjy3ZhVHQ9cq+/v4XkyBiV4y/DdmFUVDFyn4/DZeSIIKYPP8OCNQQoTZLDq8N15LAQleMrw3phWFAJXrOXy5YQ1Cyt9zfHajjsFFHLL89+SSw8PV6/k7+COQgsZaL3u8N+MTwoQYLDm7+OVUBQRVa7l7+KRTA0NUqPi8N+PSwwNUqXj8+OVUBMQYLDn8OGVTgwKSZ3e8eOYUxIMUqXj8uSUSg0JR5va8OOYVBkPXa3l7+KQTA8OV6/k7+CQTw0IQMFH';

const DEPTH_COLORS = {
    bids: { 1: '#00ff88', 2: '#00cc70', 3: '#26a69a', 5: '#00897b', 8: '#00695c', 10: '#004d40', 20: '#7b1fa2', 40: '#6a1b9a', 60: '#4a148c' },
    asks: { 1: '#ff5252', 2: '#f44336', 3: '#ef5350', 5: '#e53935', 8: '#d32f2f', 10: '#c62828', 20: '#ff6f00', 40: '#e65100', 60: '#bf360c' }
};

function getAppBaseUrl() {
    if (typeof window !== 'undefined' && window.location.protocol === 'file:') return 'http://127.0.0.1:5050';
    return (typeof window !== 'undefined' && window.location.origin) ? window.location.origin : 'http://127.0.0.1:5050';
}

// Timezone is a *display* concern only. Every series on this page — depth,
// price, crossover markers, trader ratios, volume — keeps its timestamps in
// raw UTC so they all share one axis. The offset is applied when a timestamp
// is turned into text, never to the timestamp itself. Shifting the data (as
// this file used to do for markers/traders/volume but not for depth) put the
// series on different clocks and misaligned them by the offset.
function shiftedDate(ts) {
    return new Date((ts + currentTimezoneOffset * 3600) * 1000);
}

function formatTimeWithOffset(ts, withSeconds = false) {
    const d = shiftedDate(ts);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    if (!withSeconds) return `${hh}:${mm}`;
    return `${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function formatDateTimeWithOffset(ts) {
    const d = shiftedDate(ts);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${dd}.${mo} ${formatTimeWithOffset(ts, true)}`;
}

// Both charts read currentTimezoneOffset through the closures above, so
// changing the offset only needs a redraw — no refetch, no history reset.
function applyTimezoneToCharts() {
    const opts = {
        localization: { timeFormatter: formatDateTimeWithOffset },
        timeScale: { tickMarkFormatter: (t) => formatTimeWithOffset(t, currentTimeframe === 0) }
    };
    if (chart) chart.applyOptions(opts);
    if (volumeChart) volumeChart.applyOptions({
        localization: { timeFormatter: formatDateTimeWithOffset },
        timeScale: { tickMarkFormatter: (t) => formatTimeWithOffset(t, false) }
    });
}

function updateTimezoneDisplay() {
    const offset = currentTimezoneOffset;
    const sign = offset >= 0 ? '+' : '';
    document.getElementById('current-timezone-display').textContent = `UTC${sign}${offset}`;
}

function playNotificationSound() {
    const soundEnabled = document.getElementById('sound-enabled').checked;
    if (!soundEnabled) return;
    try {
        const audio = new Audio(BEEP_SOUND);
        audio.volume = 0.5;
        audio.play().catch(err => console.log('Sound blocked by browser:', err));
    } catch (error) {
        console.error('Sound error:', error);
    }
}

function initChart() {
    const chartContainer = document.getElementById('chart-container');
    if (chart) chart.remove();

    chart = LightweightCharts.createChart(chartContainer, {
        layout: { background: { type: 'solid', color: '#0e0e0e' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#333', visible: true },
        leftPriceScale: { borderColor: '#333', visible: true },
        localization: { timeFormatter: formatDateTimeWithOffset },
        timeScale: {
            borderColor: '#333', timeVisible: true,
            secondsVisible: currentTimeframe === 0,
            tickMarkFormatter: (t) => formatTimeWithOffset(t, currentTimeframe === 0)
        },
        width: chartContainer.clientWidth,
        height: 760
    });

    priceSeries = chart.addLineSeries({
        color: '#ffffff', lineWidth: 2, title: 'BTC Price',
        priceScaleId: 'left', lastValueVisible: true, priceLineVisible: true
    });

    initFootprintSeries();
    setupFootprintTooltip();

    window.addEventListener('resize', () => chart.applyOptions({ width: chartContainer.clientWidth }));
    updateChartSeries();
}

// ── Footprint (directional volume) overlay ─────────────────────────────
//
// Two histogram series share the same pane as the price line, each pinned
// to its own reserved price-scale strip: fp-up occupies the bottom ~28% of
// the pane and always renders values >= 0 (so bars grow UP from the very
// bottom edge), fp-down occupies the top ~28% and always renders values
// <= 0 (so bars grow DOWN from the very top edge). autoscaleInfoProvider
// pins each scale's 0-line to the edge shared with the price pane instead
// of letting it float, which is what makes the "grows from bottom / grows
// from top" behaviour exact rather than approximate.
function initFootprintSeries() {
    fpUpSeries = chart.addHistogramSeries({
        priceScaleId: 'fp-up',
        color: 'rgba(0, 212, 255, 0.55)',
        priceFormat: { type: 'volume' },
        base: 0,
        priceLineVisible: false,
        lastValueVisible: false,
    });
    chart.priceScale('fp-up').applyOptions({ scaleMargins: { top: 0.72, bottom: 0 }, visible: false });

    fpDownSeries = chart.addHistogramSeries({
        priceScaleId: 'fp-down',
        color: 'rgba(255, 82, 82, 0.55)',
        priceFormat: { type: 'volume' },
        base: 0,
        priceLineVisible: false,
        lastValueVisible: false,
    });
    chart.priceScale('fp-down').applyOptions({ scaleMargins: { top: 0, bottom: 0.72 }, visible: false });
}

// depth mode: "volume" = sum of bid+ask order-book volume across the
// currently-selected depth bands; direction = whether price rose or fell
// versus the previous bucket.
function computeFootprintFromDepth(list) {
    const upPoints = [], downPoints = [];
    const tooltipData = new Map();
    const depths = getSelectedDepths();
    let prevPrice = null;
    let maxUp = 0, maxDown = 0;

    list.forEach(point => {
        let total = 0;
        const perDepth = {};
        depths.forEach(d => {
            if (point[d]) {
                const bid = point[d].bidVolume || 0, ask = point[d].askVolume || 0;
                perDepth[d] = { bidVolume: bid, askVolume: ask };
                total += bid + ask;
            }
        });
        const rising  = prevPrice !== null && point.price > prevPrice;
        const falling = prevPrice !== null && point.price < prevPrice;

        if (rising) {
            upPoints.push({ time: point.time, value: total });
            downPoints.push({ time: point.time, value: 0 });
            maxUp = Math.max(maxUp, total);
        } else if (falling) {
            upPoints.push({ time: point.time, value: 0 });
            downPoints.push({ time: point.time, value: -total });
            maxDown = Math.max(maxDown, total);
        } else {
            upPoints.push({ time: point.time, value: 0 });
            downPoints.push({ time: point.time, value: 0 });
        }

        tooltipData.set(point.time, {
            price: point.price, total, perDepth,
            direction: rising ? 'up' : falling ? 'down' : 'flat'
        });
        prevPrice = point.price;
    });

    fpTooltipDataDepth = tooltipData;
    fpMaxUp = maxUp || 1;
    fpMaxDown = maxDown || 1;
    return { upPoints, downPoints };
}

// traded mode: "volume" = actual executed buy+sell volume for the period
// (same source as the Volume Delta section below); direction = sign of the
// taker buy/sell imbalance for that bucket. This runs on volumeDataHistory's
// own timestamps, which come from a different Binance endpoint (and its own
// `volume-period` control) than the depth history above — the two are not
// forced onto one grid, each is shown honestly on its own time axis.
function computeFootprintFromTraded() {
    const upPoints = [], downPoints = [];
    const tooltipData = new Map();
    let maxUp = 0, maxDown = 0;

    volumeDataHistory.forEach(point => {
        const rising  = point.imbalance > 0.02;
        const falling = point.imbalance < -0.02;

        if (rising) {
            upPoints.push({ time: point.time, value: point.totalVol });
            downPoints.push({ time: point.time, value: 0 });
            maxUp = Math.max(maxUp, point.totalVol);
        } else if (falling) {
            upPoints.push({ time: point.time, value: 0 });
            downPoints.push({ time: point.time, value: -point.totalVol });
            maxDown = Math.max(maxDown, point.totalVol);
        } else {
            upPoints.push({ time: point.time, value: 0 });
            downPoints.push({ time: point.time, value: 0 });
        }

        tooltipData.set(point.time, {
            buyVol: point.buyVol, sellVol: point.sellVol, totalVol: point.totalVol,
            imbalance: point.imbalance, direction: rising ? 'up' : falling ? 'down' : 'flat'
        });
    });

    fpTooltipDataTraded = tooltipData;
    fpMaxUp = maxUp || 1;
    fpMaxDown = maxDown || 1;
    return { upPoints, downPoints };
}

function updateFootprintSeries() {
    if (!fpUpSeries || !fpDownSeries) return;

    if (footprintMode === 'off') {
        fpUpSeries.setData([]);
        fpDownSeries.setData([]);
        return;
    }

    const src = footprintMode === 'depth'
        ? computeFootprintFromDepth(aggregatedHistory)
        : computeFootprintFromTraded();

    fpUpSeries.setData(src.upPoints);
    fpDownSeries.setData(src.downPoints);

    // Pin 0 to the shared edge of each reserved strip — see initFootprintSeries().
    fpUpSeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: fpMaxUp } }) });
    fpDownSeries.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: -fpMaxDown, maxValue: 0 } }) });
}

// Hover tooltip: "what data is behind what's drawn" — the raw bid/ask depth
// volume or buy/sell traded volume for whatever bar is under the cursor.
function setupFootprintTooltip() {
    chart.subscribeCrosshairMove(param => {
        const tooltip = document.getElementById('footprint-tooltip');
        if (!tooltip) return;

        if (footprintMode === 'off' || !param || !param.time || !param.point) {
            tooltip.classList.add('hidden');
            return;
        }

        const map = footprintMode === 'depth' ? fpTooltipDataDepth : fpTooltipDataTraded;
        const entry = map.get(param.time);
        if (!entry) { tooltip.classList.add('hidden'); return; }

        const timeLabel = formatDateTimeWithOffset(param.time);
        let html;
        if (footprintMode === 'depth') {
            const rows = Object.entries(entry.perDepth).map(([d, v]) =>
                `D${d}: bid ${formatVolume(v.bidVolume)} / ask ${formatVolume(v.askVolume)}`
            ).join('<br>');
            html = `<div class="fp-tt-hdr">${timeLabel} · ${entry.price.toFixed(2)} (${entry.direction})</div>` +
                   `<div class="fp-tt-body">Total depth vol: ${formatVolume(entry.total)}<br>${rows}</div>`;
        } else {
            html = `<div class="fp-tt-hdr">${timeLabel} · ${entry.direction}</div>` +
                   `<div class="fp-tt-body">Buy: ${formatVolume(entry.buyVol)} · Sell: ${formatVolume(entry.sellVol)}<br>` +
                   `Total: ${formatVolume(entry.totalVol)} · Imbalance: ${entry.imbalance.toFixed(3)}</div>`;
        }
        tooltip.innerHTML = html;
        tooltip.classList.remove('hidden');

        const containerRect = document.getElementById('chart-container').getBoundingClientRect();
        let left = param.point.x + 16;
        let top  = param.point.y + 16;
        if (left + 240 > containerRect.width)  left = param.point.x - 240 - 8;
        if (top  + 90  > containerRect.height) top  = param.point.y - 90  - 8;
        tooltip.style.left = Math.max(4, left) + 'px';
        tooltip.style.top  = Math.max(4, top)  + 'px';
    });
}

function initVolumeChart() {
    const chartContainer = document.getElementById('volume-chart-container');
    if (volumeChart) volumeChart.remove();

    volumeChart = LightweightCharts.createChart(chartContainer, {
        layout: { background: { type: 'solid', color: '#0e0e0e' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#333', visible: true },
        leftPriceScale: { borderColor: '#333', visible: true },
        localization: { timeFormatter: formatDateTimeWithOffset },
        timeScale: {
            borderColor: '#333', timeVisible: true, secondsVisible: false,
            tickMarkFormatter: (t) => formatTimeWithOffset(t, false)
        },
        width: chartContainer.clientWidth,
        height: 480
    });

    // Three separate price scales. Previously every series shared 'right',
    // which squashed the ~1.0-valued ratio line into a flat line at the
    // bottom while volume figures in the thousands owned the whole range.
    //   left  → buySellRatio (~0.5 … 2.0)
    //   right → total volume + its MA (thousands)
    //   cvd   → signed delta sums (overlay, own auto-range)
    volumeDeltaSeries = volumeChart.addLineSeries({
        color: '#9c27b0', lineWidth: 2, title: 'Buy/Sell Ratio', priceScaleId: 'left'
    });

    volumeHistogramSeries = volumeChart.addHistogramSeries({
        color: '#26a69a',
        priceFormat: { type: 'volume' },
        priceScaleId: 'right'
    });

    volumeMASeries = volumeChart.addLineSeries({
        color: '#ffeb3b',
        lineWidth: 2,
        title: `MA Total Volume`,
        priceScaleId: 'right'
    });

    // Rolling net delta over N bars — an oscillator, not a CVD.
    volumeRollingDeltaSeries = volumeChart.addLineSeries({
        color: '#00bcd4',
        lineWidth: 2,
        title: 'Rolling Δ (N bars)',
        priceScaleId: 'cvd'
    });

    // True cumulative volume delta — runs from the start of the window with
    // no reset, which is what makes price/CVD divergences detectable at all.
    volumeTrueCVDSeries = volumeChart.addLineSeries({
        color: '#ffffff',
        lineWidth: 2,
        title: 'CVD (cumulative)',
        priceScaleId: 'cvd'
    });

    volumeChart.priceScale('right').applyOptions({ scaleMargins: { top: 0.65, bottom: 0 } });
    volumeChart.priceScale('cvd').applyOptions({ scaleMargins: { top: 0.05, bottom: 0.45 } });

    window.addEventListener('resize', () => volumeChart.applyOptions({ width: chartContainer.clientWidth }));
    console.log('📊 Volume Delta chart initialized');
}

function getDisplayDepths() {
    return Array.from(document.querySelectorAll('.depth-display-option.selected')).map(opt => parseInt(opt.dataset.depth));
}

function initDisplayDepthSelector() {
    document.querySelectorAll('.depth-display-option').forEach(option => {
        option.addEventListener('click', () => {
            option.classList.toggle('selected');
            if (chart && rawDepthHistory.length > 0) {
                updateChartSeries();
            }
            if (currentTimeframe === 0 && rawDepthHistory.length > 0) {
                reAggregateAndUpdate();
            } else if (currentTimeframe !== 0) {
                loadHistoricalRange(currentTimeframe);
            }
        });
    });
}

function getSelectedDepths() {
    return getDisplayDepths();
}

function updateChartSeries() {
    if (!chart) return;

    for (const key in depthSeries) {
        if (depthSeries[key].bid) chart.removeSeries(depthSeries[key].bid);
        if (depthSeries[key].ask) chart.removeSeries(depthSeries[key].ask);
    }
    depthSeries = {};

    getSelectedDepths().forEach(depth => {
        depthSeries[depth] = {
            bid: chart.addLineSeries({ color: DEPTH_COLORS.bids[depth], lineWidth: 2, title: `D${depth} Bids`, priceScaleId: 'right' }),
            ask: chart.addLineSeries({ color: DEPTH_COLORS.asks[depth], lineWidth: 2, title: `D${depth} Asks`, priceScaleId: 'right' })
        };
    });

    if (aggregatedHistory.length > 0) renderAggregatedHistory(aggregatedHistory);
}

// Common response handling shared by the realtime poll (in-memory, ~24h) and
// the historical range loader (DB-backed, up to the full 14-day retention).
function applyTrackerMeta(data) {
    currentSymbol = data.symbol;
    const symEl = document.getElementById('symbol');
    if (symEl) symEl.value = data.symbol;

    updateCount = data.updateCount;
    crossoverCount = data.crossoverCount;
    const updEl = document.getElementById('updates');
    if (updEl) updEl.textContent = updateCount;
    const crossEl = document.getElementById('crossovers');
    if (crossEl) crossEl.textContent = crossoverCount;

    if (data.maxPrice != null) {
        maxPrice = data.maxPrice;
        const e = document.getElementById('max-price'); if (e) e.textContent = maxPrice.toFixed(2);
    }
    if (data.minPrice != null) {
        minPrice = data.minPrice;
        const e = document.getElementById('min-price'); if (e) e.textContent = minPrice.toFixed(2);
    }
    if (data.startedAt) trackerStartedAt = data.startedAt;
    if (data.earliestSample) trackerEarliestSample = data.earliestSample;

    updateStatus(
        data.connected ? 'Connected (tracked by backend)' : 'Backend reconnecting to Binance…',
        data.connected ? 'connected' : 'disconnected'
    );

    const badge = document.getElementById('ob-live-badge');
    if (badge) badge.classList.toggle('live-off', !data.connected);

    const sinceEl = document.getElementById('tracking-since');
    if (sinceEl) {
        const bits = [];
        if (data.startedAt)      bits.push(`process started ${new Date(data.startedAt * 1000).toLocaleString()}`);
        if (data.earliestSample) bits.push(`oldest retained sample ${new Date(data.earliestSample * 1000).toLocaleString()}`);
        sinceEl.textContent = bits.length ? `(${bits.join(' · ')})` : '';
    }
}

function updateHeaderPrice(price) {
    const priceEl = document.getElementById('hdr-price');
    const changeEl = document.getElementById('hdr-change');
    if (!priceEl || price == null) return;
    priceEl.textContent = price.toFixed(2);
    if (prevHdrPrice != null && changeEl && price !== prevHdrPrice) {
        const diff = price - prevHdrPrice;
        changeEl.textContent = (diff > 0 ? '+' : '') + diff.toFixed(2);
        changeEl.className = 'price-change ' + (diff > 0 ? 'up' : 'down');
    }
    prevHdrPrice = price;
}

// Backend points come shaped as {time, price, depths:{3:{bidVolume,askVolume}}, crossovers}.
// Flatten into {time, price, 3:{bidVolume,askVolume}, ...} — the shape every
// render/aggregate function on this page expects.
function flattenDepthPoint(point) {
    const flat = { time: point.time, price: point.price };
    for (const depth in point.depths) flat[depth] = point.depths[depth];
    return flat;
}

// One-time bulk fetch of the realtime ~24h buffer, used to seed
// rawDepthHistory when viewing starts. Kept separate from the 1s poll below
// — re-running this every second means re-downloading and re-parsing tens
// of MB of JSON per tick once the buffer is full, which both wastes
// bandwidth/CPU for no benefit (nothing 1Hz-fresh is in there) and can
// starve other in-flight requests (e.g. loadHistoricalRange) on the
// browser's per-origin connection limit.
async function seedDepthHistory() {
    try {
        const resp = await fetch(`/api/depth/history?limit=${MAX_RAW_HISTORY}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data || !Array.isArray(data.history)) throw new Error('Malformed response');

        applyTrackerMeta(data);
        rawDepthHistory = data.history.map(flattenDepthPoint);
        if (currentTimeframe === 0) reAggregateAndUpdate();
        setDataStatus('depth', 'OK');
    } catch (error) {
        console.error('❌ Backend depth seed error:', error);
        updateStatus('Backend unreachable', 'disconnected');
        setDataStatus('depth', 'STALE', error.message);
    }
}

// Small tail fetch each 1s tick — merged onto the end of rawDepthHistory
// (already seeded in bulk by seedDepthHistory) instead of replacing it.
const REALTIME_POLL_LIMIT = 5;

async function pollBackendDepth() {
    try {
        const resp = await fetch(`/api/depth/history?limit=${REALTIME_POLL_LIMIT}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data || !Array.isArray(data.history)) throw new Error('Malformed response');

        applyTrackerMeta(data);

        const lastTime = rawDepthHistory.length ? rawDepthHistory[rawDepthHistory.length - 1].time : 0;
        const fresh = data.history.filter(p => p.time > lastTime).map(flattenDepthPoint);
        if (fresh.length) {
            rawDepthHistory.push(...fresh);
            if (rawDepthHistory.length > MAX_RAW_HISTORY) rawDepthHistory = rawDepthHistory.slice(-MAX_RAW_HISTORY);
        }

        const latest = data.history[data.history.length - 1];
        if (latest) {
            document.getElementById('current-price').textContent = latest.price.toFixed(2);
            updateHeaderPrice(latest.price);
            if (latest.depths[3]) {
                document.getElementById('d3-bids').textContent = formatVolume(latest.depths[3].bidVolume);
                document.getElementById('d3-asks').textContent = formatVolume(latest.depths[3].askVolume);
            }
            if (latest.depths[5]) {
                document.getElementById('d5-bids').textContent = formatVolume(latest.depths[5].bidVolume);
                document.getElementById('d5-asks').textContent = formatVolume(latest.depths[5].askVolume);
            }
        }

        // Only sound/mark crossovers newer than the last poll, so re-polling the
        // same history every second doesn't replay old alerts.
        const freshCrossovers = data.history.filter(p => p.time > lastMarkerTime && p.crossovers.length > 0);
        if (freshCrossovers.length > 0) {
            playNotificationSound();
            freshCrossovers.forEach(p => addCrossoverMarkers(p.time, p.crossovers));
        }
        if (latest) lastMarkerTime = latest.time;

        // Only drive the chart off the realtime buffer while in "current"
        // mode — otherwise this would clobber a loaded historical range
        // (which can span far more than the ~24h this endpoint covers) with
        // a re-aggregation of just the last day, every second.
        if (currentTimeframe === 0) reAggregateAndUpdate();
        setDataStatus('depth', 'OK');
    } catch (error) {
        console.error('❌ Backend depth fetch error:', error);
        updateStatus('Backend unreachable', 'disconnected');
        setDataStatus('depth', 'STALE', error.message);
    }
}

// DB-backed range query — reaches past the ~24h in-memory window into the
// full retention (up to 14 days), bucketed server-side to `tfMinutes` so the
// browser never has to pull/render raw 1Hz samples over a multi-day span.
async function loadHistoricalRange(tfMinutes) {
    try {
        // Pull from the oldest sample still on disk, not this process's own
        // start time — DepthTracker persists across restarts, so "full
        // retained history" must survive a restart too. Falls back to the
        // 14-day retention edge if no poll has reported earliestSample yet.
        const since  = trackerEarliestSample || (Math.floor(Date.now() / 1000) - 14 * 86400);
        const bucket = tfMinutes * 60;
        const resp = await fetch(`/api/depth/history?since=${since}&bucket=${bucket}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data || !Array.isArray(data.history)) throw new Error('Malformed response');

        applyTrackerMeta(data);
        const flat = data.history.map(flattenDepthPoint);
        renderAggregatedHistory(flat);
        // Show the full loaded range by default — the whole point of this
        // path is viewing more history than the realtime ~24h window, so
        // landing zoomed into the last few bars would defeat it.
        chart.timeScale().fitContent();

        const latest = flat[flat.length - 1];
        if (latest) {
            document.getElementById('current-price').textContent = latest.price.toFixed(2);
            updateHeaderPrice(latest.price);
        }
        setDataStatus('depth', 'OK');
    } catch (error) {
        console.error('❌ Historical range fetch error:', error);
        setDataStatus('depth', 'STALE', error.message);
    }
}

function startDepthPolling() {
    const symbol = document.getElementById('symbol').value.toLowerCase().trim();
    if (!symbol) { alert('Enter symbol'); return; }
    currentSymbol = symbol; // set synchronously so trader/volume fetches below don't no-op

    rawDepthHistory = [];
    aggregatedHistory = [];
    lastMarkerTime = 0;
    document.getElementById('crossovers').textContent = '0';
    document.getElementById('max-price').textContent = '-';
    document.getElementById('min-price').textContent = '-';

    document.getElementById('connect-btn').disabled = true;
    document.getElementById('disconnect-btn').disabled = false;
    updateStatus('Loading backend history…', 'disconnected');

    if (depthPollInterval) clearInterval(depthPollInterval);
    seedDepthHistory().then(() => {
        depthPollInterval = setInterval(pollBackendDepth, 1000);
    });
}

function stopDepthPolling() {
    if (depthPollInterval) {
        clearInterval(depthPollInterval);
        depthPollInterval = null;
    }
    document.getElementById('connect-btn').disabled = false;
    document.getElementById('disconnect-btn').disabled = true;
    updateStatus('Viewing paused (backend keeps tracking)', 'disconnected');
}

function addCrossoverMarkers(timestamp, depths) {
    depths.forEach(depth => {
        if (depthSeries[depth]) {
            const existingMarkers = depthSeries[depth].bid.markers ? depthSeries[depth].bid.markers() : [];
            const newMarker = { time: timestamp, position: 'inBar', color: '#ff9800', shape: 'circle', text: 'X' };
            depthSeries[depth].bid.setMarkers([...existingMarkers, newMarker]);
        }
    });
}

function aggregateData(rawData, timeframeMinutes) {
    if (rawData.length === 0) return [];
    if (timeframeMinutes === 0) return rawData;

    const timeframeSeconds = timeframeMinutes * 60;
    const aggregated = [];
    const groups = {};

    rawData.forEach(point => {
        const bucketTime = Math.floor(point.time / timeframeSeconds) * timeframeSeconds;
        if (!groups[bucketTime]) groups[bucketTime] = [];
        groups[bucketTime].push(point);
    });

    Object.keys(groups).sort((a, b) => a - b).forEach(bucketTime => {
        const points = groups[bucketTime];
        const aggregatedPoint = { time: parseInt(bucketTime), price: average(points.map(p => p.price)) };

        getSelectedDepths().forEach(depth => {
            if (points[0][depth]) {
                aggregatedPoint[depth] = {
                    bidVolume: average(points.map(p => p[depth].bidVolume)),
                    askVolume: average(points.map(p => p[depth].askVolume))
                };
            }
        });

        aggregated.push(aggregatedPoint);
    });

    return aggregated;
}

function average(arr) {
    return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

function calculateMA(data, period) {
    const ma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            ma.push(null);
        } else {
            const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
            ma.push(sum / period);
        }
    }
    return ma;
}

// Rolling net delta over a fixed window. This is an oscillator: the window
// resets its memory every N bars. It was previously named calculateCVD, which
// it is not — a rolling window cannot show a price/CVD divergence, because
// divergence needs memory over exactly the span the window discards.
function rollingDelta(data, period) {
    const out = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            out.push(null);
        } else {
            out.push(data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0));
        }
    }
    return out;
}

// True cumulative volume delta: running sum from the start of the series,
// never reset. This is the series that carries divergences.
function calculateTrueCVD(deltas) {
    let acc = 0;
    return deltas.map(d => (acc += d));
}

function aggregateAndUpdate() {
    renderAggregatedHistory(aggregateData(rawDepthHistory, currentTimeframe));
}

function reAggregateAndUpdate() {
    renderAggregatedHistory(aggregateData(rawDepthHistory, currentTimeframe));
}

// Single render path shared by the realtime (client-aggregated) flow and the
// historical-range (server-bucketed) flow — keeps price line, depth series
// and the footprint overlay from ever drifting out of sync with each other.
function renderAggregatedHistory(list) {
    aggregatedHistory = list;

    getSelectedDepths().forEach(depth => {
        if (depthSeries[depth]) {
            const bidData = [], askData = [];
            list.forEach(point => {
                if (point[depth]) {
                    bidData.push({ time: point.time, value: point[depth].bidVolume });
                    askData.push({ time: point.time, value: point[depth].askVolume });
                }
            });
            depthSeries[depth].bid.setData(bidData);
            depthSeries[depth].ask.setData(askData);
        }
    });

    if (priceSeries) {
        priceSeries.setData(list.map(point => ({ time: point.time, value: point.price })));
    }

    if (footprintMode === 'depth') updateFootprintSeries();
}

function formatVolume(volume) {
    if (volume >= 1000000) return (volume / 1000000).toFixed(2) + 'M';
    else if (volume >= 1000) return (volume / 1000).toFixed(2) + 'K';
    return volume.toFixed(2);
}

function updateStatus(text, statusClass) {
    document.getElementById('status-text').textContent = text;
    document.getElementById('status').className = statusClass;
}

// A decision tool has to tell "no signal" apart from "no data". Every fetch
// path reports here; renderDataStatus shows the age of the last good response
// per source so frozen numbers can't be mistaken for a quiet market.
function setDataStatus(source, state, msg = '') {
    const entry = dataStatus[source];
    if (!entry) return;
    entry.state = state;
    entry.msg = msg;
    if (state === 'OK') entry.ts = Date.now();
    renderDataStatus();
}

function renderDataStatus() {
    const el = document.getElementById('data-quality');
    if (!el) return;
    const labels = { depth: 'Depth', volume: 'Volume', trader: 'Traders' };
    el.innerHTML = Object.keys(dataStatus).map(key => {
        const s = dataStatus[key];
        const age = s.ts ? Math.round((Date.now() - s.ts) / 1000) : null;
        let color = '#888', text = 'no data yet';
        if (s.state === 'OK') {
            color = age !== null && age > 180 ? '#ff9800' : '#26a69a';
            text = age !== null ? `${age}s ago` : 'ok';
        } else if (s.state === 'STALE') {
            color = '#ef5350';
            text = age !== null ? `STALE · last ok ${age}s ago` : 'STALE · never loaded';
        }
        const title = s.msg ? ` title="${s.msg.replace(/"/g, '&quot;')}"` : '';
        return `<span class="dq-item"${title}><span class="dq-dot" style="background:${color}"></span>` +
               `<span class="dq-label">${labels[key]}</span>` +
               `<span class="dq-text" style="color:${color}">${text}</span></span>`;
    }).join('');
}

function setTimeframe(tf, btnEl) {
    currentTimeframe = tf;
    document.getElementById('current-tf').textContent = tf === 0 ? 'C (current)' : (tf === 60 ? '1h' : `${tf}m`);
    chart.applyOptions({ timeScale: { secondsVisible: tf === 0 } });

    document.querySelectorAll('.tf-button').forEach(btn => btn.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');

    if (historicalRefreshInterval) {
        clearInterval(historicalRefreshInterval);
        historicalRefreshInterval = null;
    }

    if (tf === 0) {
        if (rawDepthHistory.length > 0) reAggregateAndUpdate();
    } else {
        // Non-"current" timeframes read the full retained history from the
        // DB rather than just re-slicing the ~24h realtime buffer — see
        // loadHistoricalRange(). Refreshed periodically to pick up new bars.
        loadHistoricalRange(tf);
        historicalRefreshInterval = setInterval(() => loadHistoricalRange(tf), 30000);
    }
}

async function fetchTopTraderPositionRatio(symbol, period, limit = 100) {
    const url = `https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol.toUpperCase()}&period=${period}&limit=${limit}`;
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        return [];
    }
}

async function fetchTopTraderAccountRatio(symbol, period, limit = 100) {
    const url = `https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol.toUpperCase()}&period=${period}&limit=${limit}`;
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        return [];
    }
}

async function fetchGlobalAccountRatio(symbol, period, limit = 100) {
    const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol.toUpperCase()}&period=${period}&limit=${limit}`;
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        return [];
    }
}

async function fetchTakerBuySellVolume(symbol, period, limit = 100) {
    const url = `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol.toUpperCase()}&period=${period}&limit=${limit}`;
    try {
        const response = await fetch(url);
        return await response.json();
    } catch (error) {
        return [];
    }
}

async function fetchAllTraderData() {
    if (!currentSymbol) return;

    const period = document.getElementById('volume-period').value;

    try {
        const [tPositionData, tAccountData, gAccountData] = await Promise.all([
            fetchTopTraderPositionRatio(currentSymbol, period),
            fetchTopTraderAccountRatio(currentSymbol, period),
            fetchGlobalAccountRatio(currentSymbol, period)
        ]);

        const combinedData = {};

        if (!tPositionData.length && !tAccountData.length && !gAccountData.length) {
            throw new Error('All three trader-ratio endpoints returned empty');
        }

        tPositionData.forEach(item => {
            const timestamp = Math.floor(item.timestamp / 1000);
            if (!combinedData[timestamp]) combinedData[timestamp] = {};
            combinedData[timestamp].tposition = parseFloat(item.longShortRatio);
        });

        tAccountData.forEach(item => {
            const timestamp = Math.floor(item.timestamp / 1000);
            if (!combinedData[timestamp]) combinedData[timestamp] = {};
            combinedData[timestamp].taccount = parseFloat(item.longShortRatio);
        });

        gAccountData.forEach(item => {
            const timestamp = Math.floor(item.timestamp / 1000);
            if (!combinedData[timestamp]) combinedData[timestamp] = {};
            combinedData[timestamp].gaccount = parseFloat(item.longShortRatio);
        });

        traderDataHistory = Object.keys(combinedData)
            .sort((a, b) => a - b)
            .map(timestamp => ({ time: parseInt(timestamp), ...combinedData[timestamp] }));

        updateTraderTable();
        setDataStatus('trader', 'OK');

    } catch (error) {
        // Never swallow this: stale trader ratios look identical to live ones.
        setDataStatus('trader', 'STALE', error.message);
    }
}

async function fetchAllVolumeData() {
    if (!currentSymbol) return;

    const period = document.getElementById('volume-period').value;

    try {
        const volumeData = await fetchTakerBuySellVolume(currentSymbol, period);
        if (!Array.isArray(volumeData) || volumeData.length === 0) {
            throw new Error('takerlongshortRatio returned no rows');
        }

        volumeDataHistory = volumeData.map(item => {
            const buyVol  = parseFloat(item.buyVol);
            const sellVol = parseFloat(item.sellVol);
            const totalVol = buyVol + sellVol;
            return {
                time: Math.floor(item.timestamp / 1000),
                buySellRatio: parseFloat(item.buySellRatio),
                buyVol,
                sellVol,
                // Total traded volume — the figure the "no volume, no entry"
                // rule actually needs. It was computed nowhere before.
                totalVol,
                // Normalised skew in -1…+1, comparable across a quiet Tuesday
                // and a cascade. Raw buySellRatio is not.
                imbalance: totalVol > 0 ? (buyVol - sellVol) / totalVol : 0
            };
        }).sort((a, b) => a.time - b.time);

        updateVolumeCharts();
        updateVolumeInfo();
        if (footprintMode === 'traded') updateFootprintSeries();
        setDataStatus('volume', 'OK');

    } catch (error) {
        // Previously an empty catch: on failure the charts kept rendering the
        // last good data, so "no signal" and "no data" looked the same.
        setDataStatus('volume', 'STALE', error.message);
    }
}

function updateVolumeCharts() {
    const deltaData = volumeDataHistory.map(point => ({
        time: point.time,
        value: point.buySellRatio
    }));

    // Bars are total traded volume, tinted by which side was aggressing.
    // Height used to be |buyVol - sellVol| — the imbalance magnitude, which
    // meant total volume appeared nowhere on this page.
    const histogramData = volumeDataHistory.map(point => ({
        time: point.time,
        value: point.totalVol,
        color: point.imbalance >= 0 ? '#26a69a' : '#ef5350'
    }));

    const maPeriod = parseInt(document.getElementById('ma-period').value) || 14;
    // MA of total volume. It used to average |delta|, so the line labelled
    // "MA Volume" was really the mean imbalance magnitude.
    const maValues = calculateMA(volumeDataHistory.map(p => p.totalVol), maPeriod);

    const maData = volumeDataHistory.map((point, index) => ({
        time: point.time,
        value: maValues[index]
    })).filter(d => d.value !== null);

    const cvdPeriod = parseInt(document.getElementById('cvd-period').value) || 12;
    const deltaValues = volumeDataHistory.map(point => point.buyVol - point.sellVol);

    const rollingValues = rollingDelta(deltaValues, cvdPeriod);
    const rollingData = volumeDataHistory.map((point, index) => ({
        time: point.time,
        value: rollingValues[index]
    })).filter(d => d.value !== null);

    const trueCvdValues = calculateTrueCVD(deltaValues);
    const trueCvdData = volumeDataHistory.map((point, index) => ({
        time: point.time,
        value: trueCvdValues[index]
    }));

    if (volumeDeltaSeries && deltaData.length > 0) {
        volumeDeltaSeries.setData(deltaData);
    }

    if (volumeHistogramSeries && histogramData.length > 0) {
        volumeHistogramSeries.setData(histogramData);
    }

    if (volumeMASeries && maData.length > 0) {
        volumeMASeries.setData(maData);
    }

    if (volumeRollingDeltaSeries && rollingData.length > 0) {
        volumeRollingDeltaSeries.setData(rollingData);
    }

    if (volumeTrueCVDSeries && trueCvdData.length > 0) {
        volumeTrueCVDSeries.setData(trueCvdData);
    }
}

function updateTraderTable() {
    if (traderDataHistory.length === 0) return;

    const latest = traderDataHistory[traderDataHistory.length - 1];
    const previous = traderDataHistory.length > 1 ? traderDataHistory[traderDataHistory.length - 2] : null;

    // T-Position
    if (latest.tposition) {
        const value = latest.tposition.toFixed(4);
        const change = previous && previous.tposition ? ((latest.tposition - previous.tposition) / previous.tposition * 100).toFixed(2) : 0;
        const changeClass = change > 0 ? 'change-positive' : change < 0 ? 'change-negative' : 'change-neutral';
        const arrow = change > 0 ? '<span class="arrow-up">▲</span>' : change < 0 ? '<span class="arrow-down">▼</span>' : '-';
        const status = latest.tposition >= 1 ? '<span style="color: #26a69a;">Bullish</span>' : '<span style="color: #ef5350;">Bearish</span>';

        document.getElementById('tposition-value').innerHTML = `<span style="color: ${latest.tposition >= 1 ? '#26a69a' : '#ef5350'};">${value}</span>`;
        document.getElementById('tposition-change').innerHTML = `<span class="${changeClass}">${change > 0 ? '+' : ''}${change}%</span>`;
        document.getElementById('tposition-trend').innerHTML = arrow;
        document.getElementById('tposition-status').innerHTML = status;
    }

    // T-Account
    if (latest.taccount) {
        const value = latest.taccount.toFixed(4);
        const change = previous && previous.taccount ? ((latest.taccount - previous.taccount) / previous.taccount * 100).toFixed(2) : 0;
        const changeClass = change > 0 ? 'change-positive' : change < 0 ? 'change-negative' : 'change-neutral';
        const arrow = change > 0 ? '<span class="arrow-up">▲</span>' : change < 0 ? '<span class="arrow-down">▼</span>' : '-';
        const status = latest.taccount >= 1 ? '<span style="color: #26a69a;">Bullish</span>' : '<span style="color: #ef5350;">Bearish</span>';

        document.getElementById('taccount-value').innerHTML = `<span style="color: ${latest.taccount >= 1 ? '#26a69a' : '#ef5350'};">${value}</span>`;
        document.getElementById('taccount-change').innerHTML = `<span class="${changeClass}">${change > 0 ? '+' : ''}${change}%</span>`;
        document.getElementById('taccount-trend').innerHTML = arrow;
        document.getElementById('taccount-status').innerHTML = status;
    }

    // G-Account
    if (latest.gaccount) {
        const value = latest.gaccount.toFixed(4);
        const change = previous && previous.gaccount ? ((latest.gaccount - previous.gaccount) / previous.gaccount * 100).toFixed(2) : 0;
        const changeClass = change > 0 ? 'change-positive' : change < 0 ? 'change-negative' : 'change-neutral';
        const arrow = change > 0 ? '<span class="arrow-up">▲</span>' : change < 0 ? '<span class="arrow-down">▼</span>' : '-';
        const status = latest.gaccount >= 1 ? '<span style="color: #26a69a;">Bullish</span>' : '<span style="color: #ef5350;">Bearish</span>';

        document.getElementById('gaccount-value').innerHTML = `<span style="color: ${latest.gaccount >= 1 ? '#26a69a' : '#ef5350'};">${value}</span>`;
        document.getElementById('gaccount-change').innerHTML = `<span class="${changeClass}">${change > 0 ? '+' : ''}${change}%</span>`;
        document.getElementById('gaccount-trend').innerHTML = arrow;
        document.getElementById('gaccount-status').innerHTML = status;
    }

    // Overall Sentiment
    const avgSentiment = ((latest.tposition || 1) + (latest.taccount || 1) + (latest.gaccount || 1)) / 3;
    const sentimentText = avgSentiment > 1.2 ? 'Strong Bull 🚀' : avgSentiment > 1 ? 'Bullish 📈' : avgSentiment > 0.8 ? 'Bearish 📉' : 'Strong Bear 🐻';
    document.getElementById('sentiment-value').innerHTML = `<span style="color: ${avgSentiment >= 1 ? '#26a69a' : '#ef5350'};">${sentimentText}</span>`;
}

function updateVolumeInfo() {
    if (volumeDataHistory.length === 0) return;
    const latest = volumeDataHistory[volumeDataHistory.length - 1];

    const deltaValue = latest.buySellRatio.toFixed(4);
    document.getElementById('volume-delta-value').textContent = deltaValue;
    document.getElementById('volume-delta-value').style.color = latest.buySellRatio >= 1 ? '#26a69a' : '#ef5350';

    const totalEl = document.getElementById('total-volume-value');
    if (totalEl) totalEl.textContent = formatVolume(latest.totalVol);

    const imbEl = document.getElementById('imbalance-value');
    if (imbEl) {
        imbEl.textContent = (latest.imbalance >= 0 ? '+' : '') + latest.imbalance.toFixed(3);
        imbEl.style.color = latest.imbalance >= 0 ? '#26a69a' : '#ef5350';
    }

    const cumCvd = volumeDataHistory.reduce((sum, p) => sum + (p.buyVol - p.sellVol), 0);
    const cumEl = document.getElementById('cvd-cumulative-value');
    if (cumEl) {
        cumEl.textContent = (cumCvd >= 0 ? '+' : '−') + formatVolume(Math.abs(cumCvd));
        cumEl.style.color = cumCvd >= 0 ? '#26a69a' : '#ef5350';
    }

    const cvdPeriod = parseInt(document.getElementById('cvd-period').value) || 12;
    if (volumeDataHistory.length >= cvdPeriod) {
        const recentData = volumeDataHistory.slice(-cvdPeriod);
        const rollingSum = recentData.reduce((sum, point) => sum + (point.buyVol - point.sellVol), 0);
        document.getElementById('cvd-value').textContent = rollingSum.toFixed(2);
        document.getElementById('cvd-value').style.color = rollingSum >= 0 ? '#26a69a' : '#ef5350';
    }

    const buyPressure = ((latest.buySellRatio - 1) * 100).toFixed(2) + '%';
    document.getElementById('buy-pressure-value').textContent = buyPressure;
    document.getElementById('buy-pressure-value').style.color = latest.buySellRatio >= 1 ? '#26a69a' : '#888';

    const sentiment = latest.buySellRatio > 1.2 ? 'Strong Buy' :
                     latest.buySellRatio > 1 ? 'Buying' :
                     latest.buySellRatio > 0.8 ? 'Selling' : 'Strong Sell';
    document.getElementById('market-sentiment-value').textContent = sentiment;
    document.getElementById('market-sentiment-value').style.color = latest.buySellRatio >= 1 ? '#26a69a' : '#ef5350';
}

function startTraderDataAutoUpdate() {
    if (traderDataInterval) clearInterval(traderDataInterval);
    fetchAllTraderData();
    traderDataInterval = setInterval(() => {
        if (currentSymbol) fetchAllTraderData();
    }, 60 * 1000);
}

function startVolumeDataAutoUpdate() {
    if (volumeDataInterval) clearInterval(volumeDataInterval);
    fetchAllVolumeData();
    volumeDataInterval = setInterval(() => {
        if (currentSymbol) fetchAllVolumeData();
    }, 60 * 1000);
}

// ── World clocks (header) ───────────────────────────────────────────────
function startWorldClocks() {
    const _fmt = tz => new Date().toLocaleTimeString('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const _upd = () => {
        const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const g = id => document.getElementById(id);
        if (g('wc-local')) g('wc-local').textContent = _fmt(local);
        if (g('wc-lon'))   g('wc-lon').textContent   = _fmt('Europe/London');
        if (g('wc-bej'))   g('wc-bej').textContent   = _fmt('Asia/Shanghai');
        if (g('wc-nyc'))   g('wc-nyc').textContent   = _fmt('America/New_York');
    };
    _upd();
    setInterval(_upd, 1000);
}

// ── CoinGlass liquidation heatmap ────────────────────────────────────────
// Best-effort: the backend scrapes CoinGlass's private encrypted API with a
// session token that goes stale every few days (see coinglass_analyzer.py).
// A failed/stale fetch shows a visible warning instead of a frozen chart.
let cgHeatmapRecords = null;

async function fetchCoinglassHeatmap() {
    const statusEl = document.getElementById('cg-status');
    const noteEl = document.getElementById('cg-heatmap-note');
    try {
        const resp = await fetch('/api/liquidations/heatmap');
        const data = await resp.json();

        if (!data.ok) {
            if (statusEl) statusEl.textContent = 'CoinGlass · unavailable';
            if (noteEl) noteEl.textContent = data.error || 'CoinGlass data unavailable.';
            renderHeatmapCanvas([]);
            return;
        }

        cgHeatmapRecords = data.records;
        if (statusEl) {
            statusEl.textContent = data.stale
                ? 'CoinGlass · STALE'
                : `CoinGlass · updated ${new Date(data.fetchedAt * 1000).toLocaleTimeString()}`;
        }
        if (noteEl) noteEl.textContent = data.warning || '';
        renderHeatmapCanvas(cgHeatmapRecords);
    } catch (error) {
        if (statusEl) statusEl.textContent = 'CoinGlass · error';
        if (noteEl) noteEl.textContent = error.message;
        renderHeatmapCanvas([]);
    }
}

function heatColor(t) {
    // 0 → dim blue, 1 → hot yellow/white, passing through purple/red.
    const stops = [
        [0.00, [20, 20, 60]],
        [0.35, [90, 30, 140]],
        [0.65, [220, 40, 60]],
        [1.00, [255, 230, 80]],
    ];
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
            const f = (t - t0) / (t1 - t0 || 1);
            const c = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * f));
            return `rgb(${c[0]},${c[1]},${c[2]})`;
        }
    }
    return 'rgb(255,230,80)';
}

function renderHeatmapCanvas(records) {
    const canvas = document.getElementById('cg-heatmap-canvas');
    const wrap = document.getElementById('cg-heatmap-wrap');
    if (!canvas || !wrap) return;

    const w = wrap.clientWidth || 400, h = wrap.clientHeight || 300;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0e0e0e';
    ctx.fillRect(0, 0, w, h);

    if (!records || !records.length) {
        ctx.fillStyle = '#666';
        ctx.font = '12px monospace';
        ctx.fillText('No heatmap data available', 12, 20);
        return;
    }

    const prices = records.map(r => r.price);
    const times  = records.map(r => r.timestamp);
    const vols   = records.map(r => r.volume);
    const minP = Math.min(...prices), maxP = Math.max(...prices);
    const minT = Math.min(...times),  maxT = Math.max(...times);
    const maxV = Math.max(...vols) || 1;

    const px = t => ((t - minT) / (maxT - minT || 1)) * (w - 10) + 5;
    const py = p => h - (((p - minP) / (maxP - minP || 1)) * (h - 10) + 5);

    records.forEach(r => {
        const intensity = Math.min(1, r.volume / maxV);
        ctx.fillStyle = heatColor(intensity);
        ctx.fillRect(px(r.timestamp), py(r.price), 3, 3);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Application started');
    initChart();
    initVolumeChart();
    initDisplayDepthSelector();
    renderDataStatus();
    startWorldClocks();
    // Keep the "Ns ago" ages ticking even when nothing new arrives — a frozen
    // age is exactly the symptom that should be visible.
    setInterval(renderDataStatus, 5000);

    document.getElementById('timezone-selector').addEventListener('change', (e) => {
        currentTimezoneOffset = parseInt(e.target.value);
        updateTimezoneDisplay();
        // Data is stored in UTC and formatted at render time, so changing zone
        // is now a pure redraw — no history wipe and no refetch from Binance,
        // both of which this handler used to do.
        applyTimezoneToCharts();
    });

    document.getElementById('connect-btn').addEventListener('click', () => {
        startDepthPolling();
        startTraderDataAutoUpdate();
        startVolumeDataAutoUpdate();
    });

    document.getElementById('disconnect-btn').addEventListener('click', () => {
        stopDepthPolling();
        if (traderDataInterval) {
            clearInterval(traderDataInterval);
            traderDataInterval = null;
        }
        if (volumeDataInterval) {
            clearInterval(volumeDataInterval);
            volumeDataInterval = null;
        }
    });

    document.getElementById('update-chart-btn').addEventListener('click', () => {
        const displayDepths = getDisplayDepths();
        document.querySelectorAll('.depth-option').forEach(cb => {
            cb.checked = displayDepths.includes(parseInt(cb.value));
        });
        updateChartSeries();
    });

    document.getElementById('fetch-volume-data-btn').addEventListener('click', () => {
        fetchAllVolumeData();
        fetchAllTraderData();
    });

    document.getElementById('ma-period').addEventListener('change', () => {
        if (volumeDataHistory.length > 0) updateVolumeCharts();
    });

    document.getElementById('cvd-period').addEventListener('change', () => {
        if (volumeDataHistory.length > 0) {
            updateVolumeCharts();
            updateVolumeInfo();
        }
    });

    document.querySelectorAll('.tf-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            setTimeframe(parseInt(e.target.dataset.tf), e.target);
        });
    });

    document.querySelectorAll('.fp-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.fp-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            footprintMode = btn.dataset.mode;
            updateFootprintSeries();
            const tooltip = document.getElementById('footprint-tooltip');
            if (footprintMode === 'off' && tooltip) tooltip.classList.add('hidden');
        });
    });

    document.getElementById('btn-ob-refresh')?.addEventListener('click', () => {
        pollBackendDepth();
        if (currentSymbol) { fetchAllVolumeData(); fetchAllTraderData(); }
        fetchCoinglassHeatmap();
    });

    window.addEventListener('resize', () => renderHeatmapCanvas(cgHeatmapRecords || []));

    fetchCoinglassHeatmap();
    setInterval(fetchCoinglassHeatmap, 5 * 60 * 1000);

    // This is a continuously-tracked, always-on data source (see server.py) —
    // start viewing immediately instead of making the user press a button.
    startDepthPolling();
    startTraderDataAutoUpdate();
    startVolumeDataAutoUpdate();
});
