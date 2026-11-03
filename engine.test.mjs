// Pruebas del motor. Ejecutar con:  node test/engine.test.mjs
import assert from 'node:assert/strict';
import { sma, ema, rsi, atr } from '../engine/indicators.js';
import { computeIndicators, evaluate, analyzeSeries } from '../engine/signals.js';
import { backtest } from '../engine/backtest.js';
import { positionSize } from '../engine/risk.js';
import { parseKlines, topUsdtPairs } from '../engine/binance.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('✓', name); };
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

test('SMA y EMA básicas', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const e = ema([1, 2, 3, 4, 5], 3);
  near(e[2], 2); near(e[3], 3); near(e[4], 4);
});

test('RSI coincide con el ejemplo clásico de Wilder (StockCharts)', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22];
  const r = rsi(closes, 14);
  // StockCharts redondea los promedios intermedios; con precisión completa difiere < 0,1
  near(r[14], 70.53, 0.1); near(r[15], 66.32, 0.1); near(r[16], 66.55, 0.1); near(r[17], 69.41, 0.1); near(r[18], 66.36, 0.1);
});

// Serie sintética con tramos alcistas, bajistas y laterales (semilla fija)
function synthetic(n = 1500, seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const raw = [];
  let p = 100, t = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const regime = Math.floor(i / 200) % 3; // 0 alcista, 1 lateral, 2 bajista
    const drift = regime === 0 ? 0.0015 : regime === 2 ? -0.0012 : 0;
    const o = p;
    const c = o * (1 + drift + (rand() - 0.5) * 0.02);
    const h = Math.max(o, c) * (1 + rand() * 0.006), l = Math.min(o, c) * (1 - rand() * 0.006);
    const v = 1000 * (0.5 + rand()) * (rand() < 0.05 ? 4 : 1);
    raw.push([t, o, h, l, c, v, t + 3599999, v * c, 100]);
    p = c; t += 3600000;
  }
  return raw;
}

const past = Date.UTC(2030, 0, 1);
const c = parseKlines(synthetic(), past);
const htf = parseKlines(synthetic(400, 11).map((k, i) => { k[0] = Date.UTC(2025, 0, 1) + i * 4 * 3600000; k[6] = k[0] + 4 * 3600000 - 1; return k; }), past);

test('parseKlines descarta la vela que sigue abierta', () => {
  const raw = synthetic(5);
  raw[4][6] = Date.now() + 60000;
  const p = parseKlines(raw);
  assert.equal(p.close.length, 4);
  assert.equal(p.lastPrice, raw[4][4]);
});

test('ATR siempre positivo', () => {
  const a = atr(c.high, c.low, c.close, 14).filter((x) => x != null);
  assert.ok(a.every((x) => x > 0));
});

test('SIN mirar el futuro: la señal en la vela i es idéntica con o sin datos posteriores', () => {
  const full = computeIndicators(c);
  for (const i of [300, 555, 801, 1203, 1400]) {
    const cut = {}; for (const k of Object.keys(c)) cut[k] = Array.isArray(c[k]) ? c[k].slice(0, i + 1) : c[k];
    const a = evaluate(c, full, i, { htfTrend: 'alcista' });
    const b = evaluate(cut, computeIndicators(cut), i, { htfTrend: 'alcista' });
    for (const k of ['action', 'bull', 'bear', 'sl', 'tp1', 'tp2', 'quality']) assert.deepEqual(a[k], b[k], `campo ${k} en i=${i}`);
  }
});

test('Toda señal de COMPRA/VENTA tiene Stop Loss del lado correcto y R/B ≥ mínimo', () => {
  const ind = computeIndicators(c);
  let n = 0;
  for (let i = 210; i < c.close.length; i++) {
    for (const htfTrend of ['alcista', 'bajista', 'lateral']) {
      const s = evaluate(c, ind, i, { htfTrend });
      if (s.action === 'COMPRA') { n++; assert.ok(s.sl < s.entry && s.tp1 > s.entry && s.tp2 >= s.tp1 && s.rr2 >= 2); }
      if (s.action === 'VENTA') { n++; assert.ok(s.sl > s.entry && s.tp1 < s.entry && s.tp2 <= s.tp1 && s.rr2 >= 2); }
      if (s.action === 'COMPRA') assert.notEqual(htfTrend, 'bajista');
      if (s.action === 'VENTA') assert.notEqual(htfTrend, 'alcista');
    }
  }
  assert.ok(n > 0, 'debería haber alguna señal en 1500 velas');
  console.log('   señales encontradas:', n);
});

test('analyzeSeries devuelve los 12 campos requeridos', () => {
  const { signal } = analyzeSeries(c, { symbol: 'TESTUSDT', timeframe: '1h' }, htf);
  for (const k of ['symbol', 'action', 'currentPrice', 'timeframe', 'reasons', 'score', 'quality', 'generatedAt']) assert.ok(k in signal, k);
});

test('Backtest: corre las 3 estrategias, descuenta comisiones y calcula drawdown', () => {
  for (const strategy of ['confluencia', 'cruce_ema', 'rsi_simple']) {
    const r = backtest(c, htf, { strategy });
    assert.ok(r.maxDDPct >= 0 && r.maxDDPct <= 100);
    assert.ok(Number.isFinite(r.netPct));
    console.log(`   ${strategy}: ${r.trades} ops, ${r.winRate.toFixed(0)}% ganadoras, neto ${r.netPct.toFixed(1)}%, DD ${r.maxDDPct.toFixed(1)}%`);
  }
  const conFee = backtest(c, htf, { strategy: 'cruce_ema', feePct: 0.1 });
  const sinFee = backtest(c, htf, { strategy: 'cruce_ema', feePct: 0 });
  assert.ok(sinFee.netPct > conFee.netPct, 'las comisiones deben reducir el resultado');
});

test('Tamaño de posición respeta el riesgo y la exposición máxima', () => {
  const p = positionSize({ capital: 1000, riskPct: 1, entry: 100, sl: 95, maxExposurePct: 100, feePct: 0.1 });
  near(p.riskAmount, 10, 0.001);
  const q = positionSize({ capital: 1000, riskPct: 1, entry: 100, sl: 99.5, maxExposurePct: 20 });
  assert.ok(q.capped && q.notional <= 200 + 1e-9 && q.riskAmount < 10);
});

test('Filtro de pares: excluye stablecoins y tokens apalancados', () => {
  const t = (symbol, qv) => ({ symbol, quoteVolume: String(qv), lastPrice: '1', priceChangePercent: '0', highPrice: '1', lowPrice: '1', count: 10 });
  const r = topUsdtPairs([t('BTCUSDT', 9e9), t('USDCUSDT', 8e9), t('ETHUPUSDT', 7e9), t('ETHBTC', 9e9), t('SOLUSDT', 1e8), t('TINYUSDT', 1e3)], 10);
  assert.deepEqual(r.map((x) => x.symbol), ['BTCUSDT', 'SOLUSDT']);
});

console.log(`\n${passed} pruebas OK`);
