/**
 * Node test for the weekly growth/fall move math and liquidation math in
 * js/zones.js (pure functions).
 * Run:  node tests/zones.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  computeZigzag, zigzagLegs, clusterRepeatedHvn, liqProfile,
  buildRangeProfile, findHvnZones, markZoneBreaks, prepHeatmap, heatSnapshot,
  findSignificantLiqZones, buildCumulativeLiqCurve,
} = require(path.join(here, '..', 'js', 'zones.js'));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

const mk = (t, o, h, l, c, vol) => ({ time: t, open: o, high: h, low: l, close: c, volume: vol });

// ── computeZigzag / zigzagLegs ───────────────────────────────────────────

/** Hand-verifiable swing sequence at deviationPct=5:
 *  idx0 low=99 (seed) → idx2 high=150 (retrace to 130 <= 142.5 confirms it)
 *  → idx4 low=90 (rally to 140 >= 94.5 confirms it) → idx5 high=140 (trailing,
 *  provisional — the series ends before it reverses). */
function zigzagFixture() {
  return [
    mk(0, 99.5, 100, 99, 99.5, 10),
    mk(1, 105, 110, 100, 109, 10),
    mk(2, 110, 150, 109, 149, 10),
    mk(3, 140, 145, 130, 132, 10),
    mk(4, 130, 135, 90, 95, 10),
    mk(5, 95, 140, 92, 138, 10),
  ];
}

test('computeZigzag confirms alternating swing pivots plus a trailing provisional one', () => {
  const pivots = computeZigzag(zigzagFixture(), 5);
  assert.deepEqual(pivots.map(p => [p.idx, p.price, p.type]), [
    [0, 99, 'low'],
    [2, 150, 'high'],
    [4, 90, 'low'],
    [5, 140, 'high'],
  ]);
});

test('computeZigzag returns [] for fewer than 2 candles', () => {
  assert.deepEqual(computeZigzag([]), []);
  assert.deepEqual(computeZigzag([mk(0, 1, 1, 1, 1, 1)]), []);
});

test('computeZigzag returns just the seed pivot when price never moves enough to swing', () => {
  const kl = [];
  for (let i = 0; i < 10; i++) kl.push(mk(i, 100, 100, 100, 100, 10));
  assert.equal(computeZigzag(kl, 5).length, 1);
});

test('zigzagLegs pairs consecutive pivots into alternating up/down legs', () => {
  const pivots = computeZigzag(zigzagFixture(), 5);
  const legs = zigzagLegs(pivots);
  assert.equal(legs.length, 3);
  assert.deepEqual(legs[0], { t0: 0, t1: 2, isUp: true, startPrice: 99, endPrice: 150 });
  assert.equal(legs[1].isUp, false);
  assert.equal(legs[2].isUp, true);
});

// ── clusterRepeatedHvn ───────────────────────────────────────────────────

test('clusterRepeatedHvn promotes only same-direction bands backed by 3+ distinct legs', () => {
  const raw = [
    { p0: 100,   p1: 102,   peak: 101,   vol: 10, isUp: true,  legIdx: 0, fromTime: 10 },
    { p0: 101,   p1: 103,   peak: 102,   vol: 12, isUp: true,  legIdx: 2, fromTime: 20 },
    { p0: 100.5, p1: 102.5, peak: 101.5, vol: 8,  isUp: true,  legIdx: 4, fromTime: 30 },
    { p0: 200,   p1: 202,   peak: 201,   vol: 5,  isUp: true,  legIdx: 1, fromTime: 15 }, // alone
    { p0: 100,   p1: 102,   peak: 101,   vol: 9,  isUp: false, legIdx: 1, fromTime: 12 }, // wrong direction
  ];
  const zones = clusterRepeatedHvn(raw, 3);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].isUp, true);
  assert.equal(zones[0].repeats, 3);
  assert.equal(zones[0].fromTime, 30);
  assert.ok(zones[0].p0 <= 100.5 && zones[0].p1 >= 102.5);
});

test('clusterRepeatedHvn counts distinct legs, not raw band count', () => {
  const raw = [
    { p0: 100,   p1: 101,   peak: 100.5, vol: 5, isUp: true, legIdx: 0, fromTime: 1 },
    { p0: 100.5, p1: 101.5, peak: 101,   vol: 5, isUp: true, legIdx: 0, fromTime: 1 }, // same leg, chains on
  ];
  assert.deepEqual(clusterRepeatedHvn(raw, 2), []);
});

// ── buildRangeProfile ────────────────────────────────────────────────────

const mkv = (t, o, h, l, c, vol, buyVol) =>
  ({ time: t, open: o, high: h, low: l, close: c, volume: vol, buyVol });

test('buildRangeProfile bins buy/sell volume by price, excludes out-of-range candles', () => {
  const kl = [
    mkv(0, 100, 110, 100, 105, 100, 60),
    mkv(1, 105, 110, 100, 100, 300, 100),
    mkv(50, 200, 210, 200, 205, 50, 25), // outside the range → excluded
  ];
  const p = buildRangeProfile(kl, [{ t0: 0, t1: 10 }], 10);
  assert.ok(p);
  assert.equal(p.lo, 100);
  assert.equal(p.hi, 110);
  const totBuy = p.rows.reduce((s, r) => s + r.buy, 0);
  const totSell = p.rows.reduce((s, r) => s + r.sell, 0);
  assert.ok(Math.abs(totBuy - 160) < 1e-6, `buy=${totBuy}`);
  assert.ok(Math.abs(totSell - 240) < 1e-6, `sell=${totSell}`);
  assert.ok(Math.abs(p.totalVol - 400) < 1e-6);
  assert.ok(p.poc >= 100 && p.poc <= 110);
  assert.ok(p.vaLow <= p.poc && p.vaHigh >= p.poc);
});

test('buildRangeProfile puts a narrow candle\'s volume in the right row (POC)', () => {
  const kl = [
    mkv(0, 100, 120, 100, 110, 10, 5),
    mkv(1, 104, 105, 104, 104.5, 500, 250), // heavy, tight candle near 104.5
  ];
  const p = buildRangeProfile(kl, [{ t0: 0, t1: 10 }], 20);
  assert.ok(p.poc > 103 && p.poc < 106, `poc=${p.poc}`);
});

test('buildRangeProfile returns null when no candles fall in range', () => {
  assert.equal(buildRangeProfile([mkv(100, 1, 2, 1, 1, 10, 5)], [{ t0: 0, t1: 10 }], 10), null);
});

// ── findHvnZones ─────────────────────────────────────────────────────────

/** rows helper: 20 rows of height 1 starting at price 100, given totals. */
const mkRows = totals => ({
  rows: totals.map((t, i) => ({ p0: 100 + i, p1: 101 + i, buy: t / 2, sell: t / 2, total: t })),
});

test('findHvnZones picks the top-3 distinct peaks as price bands', () => {
  const totals = Array(20).fill(5);
  totals[3] = 100; totals[10] = 80; totals[17] = 60;
  const zones = findHvnZones(mkRows(totals));
  assert.equal(zones.length, 3);
  // Sorted by price ascending; each band contains its peak row.
  assert.ok(zones[0].p0 <= 103 && zones[0].p1 >= 104);
  assert.ok(zones[1].p0 <= 110 && zones[1].p1 >= 111);
  assert.ok(zones[2].p0 <= 117 && zones[2].p1 >= 118);
});

test('findHvnZones skips peaks too close to a stronger one', () => {
  const totals = Array(20).fill(0);
  totals[5] = 100; totals[6] = 90; // neighbors → one zone, not two
  const zones = findHvnZones(mkRows(totals));
  assert.equal(zones.length, 1);
  assert.ok(zones[0].p0 <= 105 && zones[0].p1 >= 107); // band spans both rows
});

test('findHvnZones expands a band over shoulders ≥ 50% of the peak', () => {
  const totals = Array(20).fill(1);
  totals[9] = 60; totals[10] = 100; totals[11] = 55; // shoulders above 50
  const zones = findHvnZones(mkRows(totals), 1);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].p0, 109);
  assert.equal(zones[0].p1, 112);
});

test('findHvnZones keeps 3 zones with a visible gap even on a broad plateau', () => {
  const totals = Array(30).fill(60); // plateau: expansion would touch everywhere
  totals[4] = 100; totals[12] = 90; totals[20] = 80;
  const zones = findHvnZones(mkRows(totals));
  assert.equal(zones.length, 3);
  assert.ok(zones[0].p1 < zones[1].p0, 'zones 0/1 must leave a gap');
  assert.ok(zones[1].p1 < zones[2].p0, 'zones 1/2 must leave a gap');
  // each band still contains its own peak
  assert.ok(zones[0].p0 <= 104 && zones[0].p1 >= 105);
  assert.ok(zones[1].p0 <= 112 && zones[1].p1 >= 113);
  assert.ok(zones[2].p0 <= 120 && zones[2].p1 >= 121);
});

test('findHvnZones caps band width at maxHalf rows per side', () => {
  const totals = Array(30).fill(90); // everything qualifies as a shoulder
  totals[15] = 100;
  const zones = findHvnZones(mkRows(totals), 1);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].p0, 112); // peak row 15 ± 3 rows
  assert.equal(zones[0].p1, 119);
});

// ── prepHeatmap ──────────────────────────────────────────────────────────

test('prepHeatmap infers grid steps, max volume, and normalizes ms timestamps', () => {
  const hm = prepHeatmap([
    { price: 100, timestamp: 1000, volume: 5 },
    { price: 110, timestamp: 1300, volume: 10 },
    { price: 120, timestamp: 1600, volume: 0 },              // empty cell → dropped
    { price: 130, timestamp: 2_500_000_000_000, volume: 2 }, // ms → s
  ]);
  assert.equal(hm.records.length, 3);
  assert.equal(hm.priceStep, 10);
  assert.equal(hm.timeStep, 300);
  assert.equal(hm.maxVol, 10);
  assert.ok(hm.records.every(r => r.timestamp < 1e12));
});

test('prepHeatmap returns null when nothing is usable', () => {
  assert.equal(prepHeatmap([]), null);
  assert.equal(prepHeatmap([{ price: 100, timestamp: 1, volume: 0 }]), null);
});

test('prepHeatmap rejects a grid priced for another symbol', () => {
  const btcGrid = [
    { price: 60000, timestamp: 1000, volume: 5 },
    { price: 65000, timestamp: 1000, volume: 8 },
  ];
  assert.equal(prepHeatmap(btcGrid, 1800), null);   // ETH chart, BTC data
  assert.ok(prepHeatmap(btcGrid, 62000) !== null);  // matching symbol passes
  assert.ok(prepHeatmap(btcGrid) !== null);         // no price → no guard
});

// ── heatSnapshot ─────────────────────────────────────────────────────────

test('heatSnapshot uses only the newest column, top-N with min separation', () => {
  const hm = prepHeatmap([
    { price: 130, timestamp: 1000, volume: 100 },  // old column — must be ignored
    { price: 100, timestamp: 1300, volume: 5 },
    { price: 110, timestamp: 1300, volume: 9 },
    { price: 120, timestamp: 1300, volume: 8 },    // 1 row from 110 → suppressed
    { price: 150, timestamp: 1300, volume: 7 },
  ]);
  const s = heatSnapshot(hm, 115);                 // priceStep 10 → minSep 20
  assert.equal(s.asOf, 1300);
  assert.deepEqual(s.levels.map(l => l.price), [110, 150]);
  assert.equal(s.levels[0].side, 'SELL');          // below current price
  assert.equal(s.levels[1].side, 'BUY');           // above current price
  assert.equal(s.maxUsd, 9);
  assert.equal(s.source, 'heat');
});

test('heatSnapshot steps back past a thin freshly-opened column', () => {
  const hm = prepHeatmap([
    { price: 100, timestamp: 1700, volume: 1 },
    { price: 130, timestamp: 1700, volume: 2 },
    { price: 160, timestamp: 1700, volume: 3 },
    { price: 100, timestamp: 2000, volume: 9 },    // newest column: only 2 cells
    { price: 130, timestamp: 2000, volume: 9 },
  ]);
  const s = heatSnapshot(hm, 120);
  assert.equal(s.asOf, 1700);
  assert.equal(s.maxUsd, 3);
  assert.equal(heatSnapshot(null, 120), null);
});

// ── markZoneBreaks ───────────────────────────────────────────────────────

test('markZoneBreaks: full pass-through from above marks broken', () => {
  const zone = { p0: 100, p1: 110, peak: 105, vol: 1 };
  const kl = [
    mk(11, 120, 121, 119, 120, 1),  // starts above the band
    mk(12, 119, 119, 95, 96, 1),    // dives clean through to 95
  ];
  const [z] = markZoneBreaks([zone], kl, 10);
  assert.equal(z.broken, true);
});

test('markZoneBreaks: a touch into the band is NOT broken', () => {
  const zone = { p0: 100, p1: 110, peak: 105, vol: 1 };
  const kl = [
    mk(11, 120, 121, 119, 120, 1),
    mk(12, 119, 119, 104, 108, 1),  // enters the band but never exits below
    mk(13, 108, 122, 107, 121, 1),  // backs out the same side it came in
  ];
  const [z] = markZoneBreaks([zone], kl, 10);
  assert.equal(z.broken, false);
});

test('markZoneBreaks: pass-through from below and single-candle engulf are broken', () => {
  const zone = { p0: 100, p1: 110, peak: 105, vol: 1 };
  const up = [mk(11, 90, 91, 89, 90, 1), mk(12, 91, 115, 91, 114, 1)];
  assert.equal(markZoneBreaks([zone], up, 10)[0].broken, true);
  const engulf = [mk(11, 105, 115, 95, 96, 1)];
  assert.equal(markZoneBreaks([zone], engulf, 10)[0].broken, true);
});

test('markZoneBreaks: candles before afterTime are ignored', () => {
  const zone = { p0: 100, p1: 110, peak: 105, vol: 1 };
  const kl = [mk(5, 120, 121, 95, 96, 1)]; // pass-through, but during the move
  assert.equal(markZoneBreaks([zone], kl, 10)[0].broken, false);
});

// ── liqProfile ───────────────────────────────────────────────────────────

test('liqProfile bins raw items by price and side, sorted ascending', () => {
  const p = liqProfile({ items: [
    { price: 62050, usd: 1_000_000, side: 'SELL' },
    { price: 62060, usd: 500_000,  side: 'SELL' },  // same $150 bin as above
    { price: 63500, usd: 2_000_000, side: 'BUY' },
  ] }, 63000);
  assert.equal(p.levels.length, 2);
  assert.ok(p.levels[0].price < p.levels[1].price);
  assert.ok(Math.abs(p.levels[0].usd - 1_500_000) < 1);
  assert.equal(p.maxUsd, 2_000_000);
});

test('liqProfile never fabricates levels when no real data exists', () => {
  const p = liqProfile({ items: [] }, 65000);
  assert.equal(p.levels.length, 0);
  assert.equal(p.maxUsd, 0);
});

// ── findSignificantLiqZones ─────────────────────────────────────────────

test('findSignificantLiqZones flags a level that jumps 10%+ over the cumulative sum before it, per side', () => {
  const levels = [
    // above current price (100) — shorts, walked ascending
    { price: 105, usd: 100, side: 'BUY' },
    { price: 110, usd: 5,   side: 'BUY' },   // 5% of 100 so far → not flagged
    { price: 115, usd: 20,  side: 'BUY' },   // 20% of 105 so far → flagged
    // below current price (100) — longs, walked descending
    { price: 95, usd: 50, side: 'SELL' },
    { price: 90, usd: 60, side: 'SELL' },    // 120% of 50 so far → flagged
  ];
  const flagged = findSignificantLiqZones(levels, 100);
  const prices = flagged.map(z => z.price).sort((a, b) => a - b);
  assert.deepEqual(prices, [90, 115]);
});

test('findSignificantLiqZones never flags the first level on a side (nothing before it)', () => {
  const levels = [{ price: 120, usd: 1_000_000, side: 'BUY' }];
  assert.deepEqual(findSignificantLiqZones(levels, 100), []);
});

test('findSignificantLiqZones returns nothing for empty input or missing price', () => {
  assert.deepEqual(findSignificantLiqZones([], 100), []);
  assert.deepEqual(findSignificantLiqZones([{ price: 120, usd: 1, side: 'BUY' }], 0), []);
  assert.deepEqual(findSignificantLiqZones(null, 100), []);
});

// ── buildCumulativeLiqCurve ──────────────────────────────────────────────

test('buildCumulativeLiqCurve accumulates outward from price, each side scaled to its own total', () => {
  const levels = [
    { price: 105, usd: 10, side: 'BUY' },
    { price: 110, usd: 30, side: 'BUY' },
    { price: 95,  usd: 20, side: 'SELL' },
    { price: 90,  usd: 5,  side: 'SELL' },
  ];
  const { above, below } = buildCumulativeLiqCurve(levels, 100);
  assert.deepEqual(above.points, [{ price: 105, cum: 10 }, { price: 110, cum: 40 }]);
  assert.equal(above.total, 40);
  assert.deepEqual(below.points, [{ price: 95, cum: 20 }, { price: 90, cum: 25 }]);
  assert.equal(below.total, 25);
});

test('buildCumulativeLiqCurve returns null sides for empty input or no price', () => {
  assert.deepEqual(buildCumulativeLiqCurve([], 100), { above: null, below: null });
  assert.deepEqual(buildCumulativeLiqCurve([{ price: 105, usd: 1, side: 'BUY' }], 0), { above: null, below: null });
  const { below } = buildCumulativeLiqCurve([{ price: 105, usd: 1, side: 'BUY' }], 100);
  assert.equal(below, null);
});

console.log(`\n${passed} passed`);
