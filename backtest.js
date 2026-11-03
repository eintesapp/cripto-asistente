// Backtesting sin información futura:
// - La señal se calcula al CIERRE de la vela i usando solo datos hasta i.
// - La entrada se ejecuta en la APERTURA de la vela i+1.
// - Si en una misma vela se tocan Stop Loss y Take Profit, se asume el Stop Loss (supuesto conservador).
// - Se descuentan comisiones en cada entrada y salida.
import { computeIndicators, evaluate, trendAt, alignIndex } from './signals.js';

export const STRATEGIES = {
  confluencia: 'Confluencia (motor de la app)',
  cruce_ema: 'Cruce EMA 9/21 sobre EMA 50',
  rsi_simple: 'Solo RSI < 30 (ingenua, para comparar)',
};

function simpleSignal(strategy, c, ind, i) {
  const a = ind.atr[i];
  if (a == null) return null;
  if (strategy === 'cruce_ema') {
    const e9 = ind.ema9, e21 = ind.ema21;
    if (e9[i - 1] <= e21[i - 1] && e9[i] > e21[i] && c.close[i] > ind.ema50[i]) {
      const entry = c.close[i], sl = entry - 1.5 * a;
      return { action: 'COMPRA', entry, sl, tp1: entry + 1.5 * (entry - sl), tp2: entry + 3 * (entry - sl) };
    }
  }
  if (strategy === 'rsi_simple') {
    if (ind.rsi[i] != null && ind.rsi[i] < 30 && ind.rsi[i - 1] >= 30) {
      const entry = c.close[i], sl = entry - 1.5 * a;
      return { action: 'COMPRA', entry, sl, tp1: entry + 1.5 * (entry - sl), tp2: entry + 3 * (entry - sl) };
    }
  }
  return null;
}

/**
 * @param c velas  @param htf velas de temporalidad superior (o null)
 * @param o { strategy, feePct, riskPct, capital, maxBars, longOnly, opts }
 */
export function backtest(c, htf, o = {}) {
  const cfg = { strategy: 'confluencia', feePct: 0.1, riskPct: 1, capital: 1000, maxBars: 48, longOnly: true, minQuality: 'media', ...o };
  const ind = computeIndicators(c);
  const hind = htf ? computeIndicators(htf) : null;
  const qRank = { baja: 0, media: 1, alta: 2 };
  let equity = cfg.capital, peak = equity, maxDD = 0, hj = 0;
  const trades = [], curve = [];
  let pos = null;
  const n = c.close.length;
  const start = Math.min(210, n - 2);

  for (let i = start; i < n - 1; i++) {
    // 1) Gestionar posición abierta con la vela i (que ocurre después de la entrada)
    if (pos && i >= pos.entryIndex) {
      const hi = c.high[i], lo = c.low[i];
      const long = pos.long;
      const hitSL = long ? lo <= pos.sl : hi >= pos.sl;
      const hitTP1 = !pos.tp1Done && (long ? hi >= pos.tp1 : lo <= pos.tp1);
      const hitTP2 = long ? hi >= pos.tp2 : lo <= pos.tp2;
      const close = (price, qty, why) => {
        const gross = (long ? price - pos.entry : pos.entry - price) * qty;
        const fee = price * qty * cfg.feePct / 100;
        pos.pnl += gross - fee; pos.qtyLeft -= qty; pos.exits.push(why);
      };
      if (hitSL) close(pos.sl, pos.qtyLeft, pos.tp1Done ? 'BE' : 'SL');
      else {
        if (hitTP1) { close(pos.tp1, pos.qty / 2, 'TP1'); pos.tp1Done = true; pos.sl = pos.entry; }
        if (pos.qtyLeft > 1e-12 && hitTP2) close(pos.tp2, pos.qtyLeft, 'TP2');
        else if (pos.qtyLeft > 1e-12 && i - pos.entryIndex >= cfg.maxBars) close(c.close[i], pos.qtyLeft, 'TIEMPO');
      }
      if (pos.qtyLeft <= 1e-12) {
        equity += pos.pnl;
        trades.push({ entryTime: c.time[pos.entryIndex], exitTime: c.closeTime[i], long, entry: pos.entry, pnl: pos.pnl, r: pos.pnl / pos.riskAmount, exits: pos.exits.join('+') });
        pos = null;
      }
    }
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    curve.push({ t: c.closeTime[i], equity });

    // 2) Buscar nueva señal al cierre de la vela i
    if (pos) continue;
    let sig;
    if (cfg.strategy === 'confluencia') {
      let htfTrend;
      if (htf) { hj = alignIndex(htf, c.closeTime[i], hj); htfTrend = hj >= 0 ? trendAt(htf, hind, hj) : 'lateral'; }
      sig = evaluate(c, ind, i, { htfTrend, opts: cfg.opts });
      if (!sig || (sig.action !== 'COMPRA' && sig.action !== 'VENTA')) continue;
      if (qRank[sig.quality] < qRank[cfg.minQuality]) continue;
    } else {
      sig = simpleSignal(cfg.strategy, c, ind, i);
      if (!sig) continue;
    }
    const long = sig.action === 'COMPRA';
    if (!long && cfg.longOnly) continue;
    const entry = c.open[i + 1];
    // Si el precio ya abrió más allá del stop o del objetivo, no se entra.
    if (long ? entry <= sig.sl || entry >= sig.tp1 : entry >= sig.sl || entry <= sig.tp1) continue;
    const perUnit = Math.abs(entry - sig.sl) + (entry + sig.sl) * cfg.feePct / 100;
    const riskAmount = equity * cfg.riskPct / 100;
    let qty = riskAmount / perUnit;
    qty = Math.min(qty, equity / entry); // sin apalancamiento
    const fee = entry * qty * cfg.feePct / 100;
    pos = { long, entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, qty, qtyLeft: qty, entryIndex: i + 1, pnl: -fee, riskAmount: qty * perUnit, exits: [], tp1Done: false };
  }

  const wins = trades.filter((t) => t.pnl > 0), losses = trades.filter((t) => t.pnl <= 0);
  const grossW = wins.reduce((s, t) => s + t.pnl, 0), grossL = -losses.reduce((s, t) => s + t.pnl, 0);
  const bh = (c.close[n - 1] - c.close[start]) / c.close[start] * 100;
  return {
    strategy: cfg.strategy,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    netPct: (equity - cfg.capital) / cfg.capital * 100,
    maxDDPct: maxDD * 100,
    profitFactor: grossL > 0 ? grossW / grossL : wins.length ? Infinity : 0,
    avgR: trades.length ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0,
    buyHoldPct: bh,
    from: c.time[start], to: c.closeTime[n - 1],
    tradeList: trades, curve,
  };
}
