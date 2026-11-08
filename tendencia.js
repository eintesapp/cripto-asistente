// Estrategia "Ruptura de 55 velas con stop que sube" (seguimiento de tendencia).
// Es la que resultó positiva en la evaluación con datos reales (diario, 20 criptos principales).
// Las mismas reglas que se probaron en evaluar-v2.mjs:
//  - Entrada: el cierre supera el máximo de las 55 velas anteriores (y la vela previa no lo superaba),
//             con el precio sobre su media de 200.
//  - Stop inicial: 2,5 × ATR(14) bajo el precio de entrada.
//  - Stop que sube: máximo alcanzado desde la entrada − 3,5 × ATR(14). Nunca baja.
import { sma, atr } from './indicators.js';

export const TREND = { len: 55, slAtr: 2.5, trailAtr: 3.5 };
export const MAJORS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'DOT', 'LTC', 'BCH', 'NEAR', 'UNI', 'ATOM', 'XLM', 'ETC', 'APT', 'SUI'].map((s) => s + 'USDT');

export function trendIndicators(c) {
  const n = c.close.length;
  const prevHigh = new Array(n).fill(null);
  for (let i = TREND.len; i < n; i++) {
    let m = -Infinity;
    for (let j = i - TREND.len; j < i; j++) if (c.high[j] > m) m = c.high[j];
    prevHigh[i] = m;
  }
  return { sma200: sma(c.close, 200), atr14: atr(c.high, c.low, c.close, 14), prevHigh };
}

/** Señal en la última vela CERRADA de `c` (velas diarias). */
export function breakoutSignal(c) {
  const x = trendIndicators(c);
  const i = c.close.length - 1;
  if (i < 205 || x.sma200[i] == null || x.atr14[i] == null || x.prevHigh[i] == null || x.prevHigh[i - 1] == null) return null;
  const close = c.close[i];
  const ok = close > x.sma200[i] && close > x.prevHigh[i] && c.close[i - 1] <= x.prevHigh[i - 1];
  if (!ok) return null;
  const a = x.atr14[i];
  return {
    candleTime: c.closeTime[i], close, atr: a,
    stopDist: TREND.slAtr * a, slPct: (TREND.slAtr * a) / close,
    breakoutLevel: x.prevHigh[i], sma200: x.sma200[i],
    reasons: [
      `Cierre ${fmt(close)} supera el máximo de las últimas ${TREND.len} velas (${fmt(x.prevHigh[i])})`,
      `Precio sobre la media de 200 (${fmt(x.sma200[i])}): tendencia de fondo alcista`,
      `Volatilidad diaria (ATR) ${fmt(a)} → stop inicial a ${(TREND.slAtr * a / close * 100).toFixed(1)}%`,
    ],
  };
}

/** Nuevo nivel del stop que sube: máximo desde `sinceTime` − 3,5 × ATR actual. */
export function trailingStop(c, sinceTime, prevHighest = 0) {
  const x = trendIndicators(c);
  const i = c.close.length - 1;
  let highest = prevHighest;
  for (let k = 0; k <= i; k++) if (c.time[k] >= sinceTime && c.high[k] > highest) highest = c.high[k];
  const a = x.atr14[i];
  return { highest, atr: a, stop: a == null ? null : highest - TREND.trailAtr * a, lastClose: c.close[i], candleTime: c.closeTime[i] };
}

function fmt(v) { return v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4); }

/**
 * Simula la estrategia sobre velas diarias (mismas reglas que evaluar-v2: sin información futura,
 * entrada en la apertura siguiente, comisión 0,1% por lado, si abre bajo el stop sale a ese precio).
 */
export function simulateTrend(c, { fee = 0.001, maxBars = 400 } = {}) {
  const x = trendIndicators(c);
  const n = c.close.length, trades = [];
  let pos = null;
  for (let i = 205; i < n; i++) {
    if (pos && i >= pos.k) {
      let px = null, why = '';
      if (c.low[i] <= pos.sl) { px = Math.min(pos.sl, c.open[i]); why = 'stop'; }
      else {
        pos.high = Math.max(pos.high, c.high[i]);
        if (x.atr14[i]) pos.sl = Math.max(pos.sl, pos.high - TREND.trailAtr * x.atr14[i]);
        if (i - pos.k >= maxBars) { px = c.close[i]; why = 'tiempo'; }
      }
      if (px != null) {
        const r = ((px - pos.entry) - (px + pos.entry) * fee) / pos.riskUnit;
        trades.push({ entryTime: c.time[pos.k], exitTime: c.closeTime[i], entry: pos.entry, exit: px, r, slPct: pos.slPct, pct: ((px * (1 - fee)) / (pos.entry * (1 + fee)) - 1) * 100, bars: i - pos.k + 1, why });
        pos = null;
      }
    }
    if (pos || i >= n - 1 || !x.atr14[i] || x.sma200[i] == null || x.prevHigh[i - 1] == null) continue;
    if (c.close[i] > x.sma200[i] && c.close[i] > x.prevHigh[i] && c.close[i - 1] <= x.prevHigh[i - 1]) {
      const entry = c.open[i + 1], sl = entry - TREND.slAtr * x.atr14[i];
      pos = { k: i + 1, entry, sl, high: entry, riskUnit: entry - sl + (entry + sl) * fee, slPct: (entry - sl) / entry };
    }
  }
  const open = pos ? { entryTime: c.time[pos.k], entry: pos.entry, stop: pos.sl, last: c.close[n - 1] } : null;
  return { trades, open };
}

/**
 * Simula una CARTERA como la maneja el bot: capital real, máximo de operaciones abiertas,
 * monto por riesgo con mínimo y tope por orden. Recibe las operaciones de simulateTrend
 * de varias monedas (con su campo symbol) y decide cuáles habría tomado el bot.
 */
export function simulatePortfolio(allTrades, { capital = 50, riskPct = 1.5, maxOpen = 3, maxOrder = 15, minOrder = 6, minNotional = 5, order = [] } = {}) {
  const rank = (s) => { const k = order.indexOf(s); return k < 0 ? 999 : k; };
  const cand = [...allTrades].sort((a, b) => a.entryTime - b.entryTime || rank(a.symbol) - rank(b.symbol));
  let equity = capital, peak = capital, maxDD = 0;
  const open = [], taken = [], curve = [{ t: cand[0]?.entryTime || 0, v: capital }];
  let skippedFull = 0, skippedCash = 0;
  const closeUntil = (t) => {
    open.sort((a, b) => a.exitTime - b.exitTime);
    while (open.length && open[0].exitTime < t) {
      const p = open.shift();
      equity += p.pnl;
      peak = Math.max(peak, equity); maxDD = Math.max(maxDD, (peak - equity) / peak);
      curve.push({ t: p.exitTime, v: equity });
    }
  };
  for (const tr of cand) {
    closeUntil(tr.entryTime);
    if (open.some((p) => p.symbol === tr.symbol)) continue;
    if (open.length >= maxOpen) { skippedFull++; continue; }
    const free = equity - open.reduce((s, p) => s + p.amount, 0);
    const minAmount = Math.max(minOrder, (minNotional * 1.15) / (1 - tr.slPct));
    let amount = Math.max((equity * riskPct / 100) / tr.slPct, minAmount);
    amount = Math.min(amount, maxOrder, free * 0.98);
    if (amount < minAmount) { skippedCash++; continue; }
    const pnl = amount * tr.pct / 100;
    const p = { ...tr, amount, pnl };
    open.push(p); taken.push(p);
  }
  closeUntil(Infinity);
  const wins = taken.filter((p) => p.pnl > 0);
  return {
    start: capital, end: equity, returnPct: (equity / capital - 1) * 100, maxDDPct: maxDD * 100,
    trades: taken.length, winRate: taken.length ? wins.length / taken.length * 100 : 0,
    skippedFull, skippedCash, taken, curve,
    best: taken.reduce((b, p) => (!b || p.pnl > b.pnl ? p : b), null),
    worst: taken.reduce((b, p) => (!b || p.pnl < b.pnl ? p : b), null),
  };
}
