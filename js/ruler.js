/**
 * Ruler tool — Tiger Trade style: hold the mouse wheel button down and drag
 * on the main price chart to measure bars crossed / price delta / % delta
 * between the press point and the current cursor. Released the instant the
 * button comes up; nothing is left behind on the chart.
 */
'use strict';

window.Ruler = (function () {
  const UP_COLOR   = '#26a69a';
  const DOWN_COLOR = '#ef5350';

  function attach(chartEl, series, chart) {
    if (!chartEl || !series || !chart) return;

    const cv = document.createElement('canvas');
    Object.assign(cv.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '6',
    });
    chartEl.appendChild(cv);
    const ctx = cv.getContext('2d');

    let rect = { width: 0, height: 0 };
    function resize() {
      const r = chartEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      rect = { width: r.width, height: r.height };
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    new ResizeObserver(resize).observe(chartEl);

    let dragging = false;
    let start = null; // {x, y}

    function pointFrom(e) {
      const r = chartEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function barsBetween(x0, x1) {
      const ts = chart.timeScale();
      const l0 = ts.coordinateToLogical(x0);
      const l1 = ts.coordinateToLogical(x1);
      if (l0 === null || l1 === null) return null;
      return Math.round(Math.abs(l1 - l0));
    }

    function draw(x1, y1) {
      const x0 = start.x, y0 = start.y;
      ctx.clearRect(0, 0, rect.width, rect.height);

      const up = y1 <= y0;
      const color = up ? UP_COLOR : DOWN_COLOR;

      const rx = Math.min(x0, x1), ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0), rh = Math.abs(y1 - y0);
      ctx.fillStyle = up ? 'rgba(38,166,154,0.14)' : 'rgba(239,83,80,0.14)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      for (const [px, py] of [[x0, y0], [x1, y1]]) {
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }

      const p0 = series.coordinateToPrice(y0);
      const p1 = series.coordinateToPrice(y1);
      const bars = barsBetween(x0, x1);
      if (p0 == null || p1 == null) return;

      const diff = p1 - p0;
      const pct = p0 !== 0 ? (diff / p0) * 100 : 0;
      const sign = diff >= 0 ? '+' : '';
      const label = `${bars == null ? '?' : bars} бар · ${sign}${diff.toFixed(2)} · ${sign}${pct.toFixed(2)}%`;

      ctx.font = "12px 'JetBrains Mono', monospace";
      const padX = 8, boxH = 22;
      const tw = ctx.measureText(label).width;
      const boxW = tw + padX * 2;
      let bx = x1 + 14, by = y1 - boxH - 10;
      if (bx + boxW > rect.width) bx = x1 - boxW - 14;
      if (bx < 0) bx = 4;
      if (by < 0) by = y1 + 10;
      if (by + boxH > rect.height) by = rect.height - boxH - 4;

      ctx.fillStyle = 'rgba(11,14,19,0.92)';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 4);
      else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#e8ecf1';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + padX, by + boxH / 2 + 1);
    }

    function stop() {
      dragging = false;
      start = null;
      chartEl.style.cursor = '';
      ctx.clearRect(0, 0, rect.width, rect.height);
    }

    chartEl.addEventListener('mousedown', e => {
      if (e.button !== 1) return;
      e.preventDefault();
      dragging = true;
      start = pointFrom(e);
      chartEl.style.cursor = 'crosshair';
    });

    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const p = pointFrom(e);
      draw(p.x, p.y);
    });

    window.addEventListener('mouseup', e => {
      if (!dragging || e.button !== 1) return;
      stop();
    });

    // Middle-click can otherwise trigger the browser's autoscroll marker or
    // an auxclick paste action — both are noise here since the button is
    // being used as a hold-to-measure trigger, not a click.
    chartEl.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    window.addEventListener('blur', () => { if (dragging) stop(); });
  }

  return { attach };
})();
