// Motor de señales por CONFLUENCIA: una señal solo aparece cuando varios
// indicadores independientes apuntan en la misma dirección. Ningún indicador
// por sí solo (por ejemplo RSI en sobreventa) genera una señal.
import { sma, ema, rsi, macd, bollinger, atr, pivots, levelsFromPivots, fibonacci } from './indicators.js';

export const DEFAULTS = {
  minRR: 2,            // relación riesgo/beneficio mínima (usando TP2)
  minScore: 5,         // puntos mínimos de confluencia para proponer operación
  maxOpposite: 2,      // puntos máximos permitidos en contra
  allowShort: true,    // mostrar señales de VENTA (en spot = vender lo que tienes / no comprar)
};

export function computeIndicators(c) {
  const vol20 = sma(c.volume, 20);
  return {
    ema9: ema(c.close, 9), ema21: ema(c.close, 21), ema50: ema(c.close, 50),
    sma200: sma(c.close, 200),
    rsi: rsi(c.close, 14),
    macd: macd(c.close),
    bb: bollinger(c.close, 20, 2),
    atr: atr(c.high, c.low, c.close, 14),
    vol20,
  };
}

// Tendencia de una temporalidad (usada como filtro de temporalidad superior).
export function trendAt(c, ind, i) {
  const p = c.close[i], e21 = ind.ema21[i], e50 = ind.ema50[i], s200 = ind.sma200[i];
  if (e21 == null || e50 == null) return 'lateral';
  if (p > e50 && e21 > e50 && (s200 == null || p > s200)) return 'alcista';
  if (p < e50 && e21 < e50 && (s200 == null || p < s200)) return 'bajista';
  return 'lateral';
}

// Índice de la última vela de la temporalidad superior cerrada antes de `closeTime`.
export function alignIndex(htf, closeTime, hint = 0) {
  let j = Math.max(0, hint);
  while (j + 1 < htf.closeTime.length && htf.closeTime[j + 1] <= closeTime) j++;
  return htf.closeTime[j] <= closeTime ? j : -1;
}

function srLevels(c, i, atrNow) {
  const from = Math.max(0, i - 150);
  const sub = { high: c.high.slice(from, i), low: c.low.slice(from, i) };
  const pv = pivots(sub.high, sub.low, 3);
  const tol = Math.max(0.004, (atrNow / c.close[i]) * 0.5);
  const all = levelsFromPivots([...pv.highs, ...pv.lows].map((p) => ({ i: p.i + from, price: p.price })), tol);
  return all;
}

const fmt = (x) => (x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));

/**
 * Evalúa la vela cerrada `i`. Solo usa datos hasta `i` (sin mirar el futuro).
 * @param c velas  @param ind indicadores  @param i índice
 * @param ctx { symbol, timeframe, htfTrend, opts }
 */
export function evaluate(c, ind, i, ctx = {}) {
  const opts = { ...DEFAULTS, ...(ctx.opts || {}) };
  const price = c.close[i];
  const a = ind.atr[i];
  const out = {
    symbol: ctx.symbol, timeframe: ctx.timeframe, action: 'ESPERAR', price,
    candleTime: c.closeTime[i], generatedAt: Date.now(), reasons: [], warnings: [], bull: 0, bear: 0,
  };
  if (a == null || ind.ema50[i] == null || i < 60) { out.reasons.push('Datos insuficientes'); return out; }

  const bull = [], bear = [];
  const add = (arr, pts, txt) => arr.push({ pts, txt });

  // 1) Tendencia de fondo
  if (ind.sma200[i] != null) {
    if (price > ind.sma200[i]) add(bull, 1, 'Precio sobre la SMA 200 (tendencia de fondo alcista)');
    else add(bear, 1, 'Precio bajo la SMA 200 (tendencia de fondo bajista)');
  }
  // 2) Alineación de EMAs
  const e9 = ind.ema9[i], e21 = ind.ema21[i], e50 = ind.ema50[i];
  if (e9 > e21 && e21 > e50) add(bull, 2, 'EMAs alineadas al alza (9 > 21 > 50)');
  else if (e9 < e21 && e21 < e50) add(bear, 2, 'EMAs alineadas a la baja (9 < 21 < 50)');
  // 3) MACD
  const h = ind.macd.hist, L = ind.macd.line, S = ind.macd.signal;
  if (h[i] != null && h[i - 1] != null) {
    if (h[i] > 0 && h[i] > h[i - 1]) add(bull, 1, 'MACD positivo y ganando fuerza');
    if (h[i] < 0 && h[i] < h[i - 1]) add(bear, 1, 'MACD negativo y ganando fuerza');
    for (let k = 0; k < 3; k++) {
      const j = i - k;
      if (L[j - 1] != null && S[j - 1] != null) {
        if (L[j - 1] <= S[j - 1] && L[j] > S[j]) { add(bull, 1, `Cruce alcista del MACD (hace ${k} velas)`); break; }
        if (L[j - 1] >= S[j - 1] && L[j] < S[j]) { add(bear, 1, `Cruce bajista del MACD (hace ${k} velas)`); break; }
      }
    }
  }
  // 4) RSI (como confirmación, nunca como señal única)
  const r = ind.rsi[i], r3 = ind.rsi[i - 3];
  if (r != null && r3 != null) {
    if (r > 50 && r < 70 && r > r3) add(bull, 1, `RSI ${r.toFixed(0)}: impulso alcista sin sobrecompra`);
    if (r < 50 && r > 30 && r < r3) add(bear, 1, `RSI ${r.toFixed(0)}: impulso bajista sin sobreventa`);
    if (r < 32 && r > ind.rsi[i - 1] && price > c.high[i - 1]) add(bull, 0.5, `RSI ${r.toFixed(0)} saliendo de sobreventa`);
    if (r > 68 && r < ind.rsi[i - 1] && price < c.low[i - 1]) add(bear, 0.5, `RSI ${r.toFixed(0)} saliendo de sobrecompra`);
    if (r >= 75) out.warnings.push(`RSI ${r.toFixed(0)}: sobrecompra, riesgo de corrección`);
    if (r <= 25) out.warnings.push(`RSI ${r.toFixed(0)}: sobreventa, riesgo de rebote`);
  }
  // 5) Volumen (comparado con el promedio de las 20 velas anteriores)
  const volAvg = ind.vol20[i - 1];
  const volRatio = volAvg ? c.volume[i] / volAvg : 1;
  out.volRatio = volRatio;
  const green = c.close[i] >= c.open[i];
  if (volRatio >= 1.5) {
    if (green) add(bull, 1, `Volumen ${volRatio.toFixed(1)}× el promedio en vela alcista`);
    else add(bear, 1, `Volumen ${volRatio.toFixed(1)}× el promedio en vela bajista`);
  }
  // 6) Soportes, resistencias y rupturas
  const levels = srLevels(c, i, a);
  const above = levels.filter((l) => l.price > price).sort((x, y) => x.price - y.price);
  const below = levels.filter((l) => l.price < price).sort((x, y) => y.price - x.price);
  const broken = levels.find((l) => c.close[i - 1] <= l.price && price > l.price);
  const lost = levels.find((l) => c.close[i - 1] >= l.price && price < l.price);
  out.breakout = false;
  if (broken && volRatio >= 1.3) { add(bull, 2, `Ruptura de resistencia ${fmt(broken.price)} con volumen`); out.breakout = { type: 'resistencia', price: broken.price }; }
  if (lost && volRatio >= 1.3) { add(bear, 2, `Ruptura de soporte ${fmt(lost.price)} con volumen`); out.breakout = { type: 'soporte', price: lost.price }; }
  // 7) Bandas de Bollinger
  const bb = ind.bb;
  if (bb.upper[i] != null) {
    if (price > bb.upper[i] && volRatio >= 1.5) add(bull, 0.5, 'Cierre sobre la banda superior de Bollinger con volumen');
    if (price < bb.lower[i] && volRatio >= 1.5) add(bear, 0.5, 'Cierre bajo la banda inferior de Bollinger con volumen');
    const w = bb.width.slice(Math.max(0, i - 100), i + 1).filter((x) => x != null);
    if (w.length > 50 && bb.width[i] <= Math.min(...w) * 1.05) out.warnings.push('Bandas de Bollinger comprimidas: posible movimiento fuerte próximo');
  }
  // 8) Fibonacci
  const fib = fibonacci(c.high, c.low, 120, i);
  out.fib = fib;
  const golden = fib.levels.filter((l) => l.ratio === 0.5 || l.ratio === 0.618);
  const nearFib = golden.find((l) => Math.abs(price - l.price) <= a * 0.5);
  if (nearFib && fib.direction === 'alcista' && green && price > c.low[i] + (c.high[i] - c.low[i]) * 0.5) add(bull, 0.5, `Rebote en zona Fibonacci ${nearFib.ratio}`);
  if (nearFib && fib.direction === 'bajista' && !green) add(bear, 0.5, `Rechazo en zona Fibonacci ${nearFib.ratio}`);
  // 9) Temporalidad superior
  if (ctx.htfTrend === 'alcista') add(bull, 1, `Temporalidad superior alcista`);
  if (ctx.htfTrend === 'bajista') add(bear, 1, `Temporalidad superior bajista`);
  out.htfTrend = ctx.htfTrend || 'n/d';

  // Volatilidad anormal
  const atrPct = ind.atr.slice(Math.max(0, i - 100), i).filter((x) => x != null);
  const med = atrPct.length ? [...atrPct].sort((x, y) => x - y)[Math.floor(atrPct.length / 2)] : a;
  out.highVolatility = a > med * 2;
  if (out.highVolatility) out.warnings.push('Volatilidad muy superior a lo normal: reduce el tamaño o espera');
  const overext = Math.abs(price - e21) > a * 3;
  if (overext) out.warnings.push('Precio muy alejado de la EMA 21: entrada tardía, riesgo de retroceso');

  const sum = (arr) => arr.reduce((s, x) => s + x.pts, 0);
  out.bull = sum(bull); out.bear = sum(bear);
  out.atr = a; out.rsi = r; out.trend = trendAt(c, ind, i);
  out.support = below[0]?.price ?? null; out.resistance = above[0]?.price ?? null;

  // Decisión
  let dir = null;
  if (out.bull >= opts.minScore && out.bear <= opts.maxOpposite && ctx.htfTrend !== 'bajista') dir = 'COMPRA';
  else if (opts.allowShort && out.bear >= opts.minScore && out.bull <= opts.maxOpposite && ctx.htfTrend !== 'alcista') dir = 'VENTA';

  if (!dir) {
    out.reasons = [...bull, ...bear].map((x) => x.txt);
    if (out.bull >= 3 && out.bear >= 3) out.reasons.unshift('Señales contradictorias: mejor no operar');
    else out.reasons.unshift(`Sin confluencia suficiente (alcista ${out.bull} / bajista ${out.bear} puntos)`);
    out.score = Math.min(10, Math.max(out.bull, out.bear));
    out.quality = 'baja';
    return out;
  }

  // Niveles de entrada, Stop Loss y Take Profit
  const long = dir === 'COMPRA';
  const entry = price;
  const struct = long ? below[0] : above[0];
  let sl;
  const slAtr = long ? entry - 1.5 * a : entry + 1.5 * a;
  if (struct) {
    const s = long ? struct.price - 0.25 * a : struct.price + 0.25 * a;
    const dist = Math.abs(entry - s);
    sl = dist >= a && dist <= 3 * a ? s : slAtr;
  } else sl = slAtr;
  const risk = Math.abs(entry - sl);
  const targets = long ? above : below;
  const firstBarrier = targets[0];
  let tp1 = long ? entry + 1.5 * risk : entry - 1.5 * risk;
  if (firstBarrier && Math.abs(firstBarrier.price - entry) >= 1.2 * risk) tp1 = long ? firstBarrier.price - 0.1 * a : firstBarrier.price + 0.1 * a;
  // TP2: 3R, pero siempre más allá de TP1 (si TP1 ya está lejos, TP1 + 1R)
  let tp2 = long ? Math.max(entry + 3 * risk, tp1 + risk) : Math.min(entry - 3 * risk, tp1 - risk);
  const barrier2 = targets.find((l) => (long ? l.price > tp1 + 0.2 * a && l.price < tp2 : l.price < tp1 - 0.2 * a && l.price > tp2));
  if (barrier2) tp2 = long ? barrier2.price - 0.1 * a : barrier2.price + 0.1 * a;
  if (firstBarrier && Math.abs(firstBarrier.price - entry) < 1.2 * risk) {
    out.warnings.push(`${long ? 'Resistencia cercana' : 'Soporte cercano'} en ${fmt(firstBarrier.price)}: puede frenar el movimiento`);
    out.nearBarrier = true;
  }
  const rr1 = Math.abs(tp1 - entry) / risk, rr2 = Math.abs(tp2 - entry) / risk;
  Object.assign(out, { entry, sl, tp1, tp2, rr1, rr2, riskPct: (risk / entry) * 100 });

  const own = long ? bull : bear, opp = long ? bear : bull;
  out.reasons = own.map((x) => x.txt);
  if (opp.length) out.reasons.push('En contra: ' + opp.map((x) => x.txt.toLowerCase()).join('; '));

  if (rr2 < opts.minRR) {
    out.reasons.unshift(`Relación riesgo/beneficio ${rr2.toFixed(1)} menor al mínimo ${opts.minRR}: no conviene`);
    out.action = 'ESPERAR'; out.wouldBe = dir; out.score = Math.min(10, own.reduce((s, x) => s + x.pts, 0)); out.quality = 'baja';
    return out;
  }
  out.action = dir;
  out.score = Math.min(10, own.reduce((s, x) => s + x.pts, 0));
  const htfAligned = (long && ctx.htfTrend === 'alcista') || (!long && ctx.htfTrend === 'bajista');
  let q = out.score >= 7 && htfAligned && volRatio >= 1.3 ? 'alta' : out.score >= 5.5 ? 'media' : 'baja';
  if (out.highVolatility || overext || out.nearBarrier || (long && r >= 75) || (!long && r <= 25)) {
    out.caution = true;
    q = q === 'alta' ? 'media' : 'baja';
  }
  out.quality = q;
  return out;
}

// Eventos para alertas (independientes de una señal completa).
export function detectEvents(c, ind, i, tf) {
  const ev = [];
  const a = ind.atr[i];
  if (a == null) return ev;
  const chg = (c.close[i] - c.open[i]) / c.open[i] * 100;
  const body = Math.abs(c.close[i] - c.open[i]);
  const volRatio = ind.vol20[i - 1] ? c.volume[i] / ind.vol20[i - 1] : 1;
  if (body >= 3 * a) ev.push({ type: chg < 0 ? 'caida' : 'subida', text: `Movimiento brusco: ${chg.toFixed(2)}% en una vela de ${tf} (${(body / a).toFixed(1)}× ATR)` });
  if (volRatio >= 4) ev.push({ type: 'volumen', text: `Volumen anómalo: ${volRatio.toFixed(1)}× el promedio en ${tf}` });
  // Cambio de tendencia: cruce EMA 21 / EMA 50 confirmado por el precio
  const e21 = ind.ema21, e50 = ind.ema50;
  if (e21[i - 1] != null && e50[i - 1] != null) {
    if (e21[i - 1] <= e50[i - 1] && e21[i] > e50[i] && c.close[i] > e50[i]) ev.push({ type: 'tendencia', text: `Cambio de tendencia a ALCISTA en ${tf} (EMA 21 cruza sobre EMA 50)` });
    if (e21[i - 1] >= e50[i - 1] && e21[i] < e50[i] && c.close[i] < e50[i]) ev.push({ type: 'tendencia', text: `Cambio de tendencia a BAJISTA en ${tf} (EMA 21 cruza bajo EMA 50)` });
  }
  const s = ind.sma200;
  if (s[i - 1] != null && ['4h', '1d'].includes(tf)) {
    if (c.close[i - 1] <= s[i - 1] && c.close[i] > s[i]) ev.push({ type: 'tendencia', text: `Recupera la SMA 200 en ${tf}` });
    if (c.close[i - 1] >= s[i - 1] && c.close[i] < s[i]) ev.push({ type: 'tendencia', text: `Pierde la SMA 200 en ${tf}` });
  }
  return ev;
}

export function analyzeSeries(c, ctx = {}, htf = null) {
  const ind = computeIndicators(c);
  const i = c.close.length - 1;
  let htfTrend = ctx.htfTrend;
  if (htf && !htfTrend) {
    const hind = computeIndicators(htf);
    const j = alignIndex(htf, c.closeTime[i]);
    htfTrend = j >= 0 ? trendAt(htf, hind, j) : 'lateral';
  }
  const sig = evaluate(c, ind, i, { ...ctx, htfTrend });
  sig.currentPrice = c.lastPrice ?? c.close[i];
  sig.events = detectEvents(c, ind, i, ctx.timeframe);
  return { signal: sig, ind };
}
