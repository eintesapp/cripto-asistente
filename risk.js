// Gestión del riesgo: tamaño de posición, exposición y pérdida diaria.

/**
 * Calcula cuánto comprar para que, si toca el Stop Loss, pierdas como máximo
 * `riskPct`% del capital (incluyendo comisiones de entrada y salida).
 */
export function positionSize({ capital, riskPct, entry, sl, maxExposurePct = 20, feePct = 0.1 }) {
  if (!(capital > 0) || !(entry > 0) || !(sl > 0) || entry === sl) return null;
  const riskAmount = capital * riskPct / 100;
  const perUnitLoss = Math.abs(entry - sl) + (entry + sl) * feePct / 100;
  let qty = riskAmount / perUnitLoss;
  let notional = qty * entry;
  const maxNotional = capital * maxExposurePct / 100;
  let capped = false;
  if (notional > maxNotional) { capped = true; notional = maxNotional; qty = notional / entry; }
  return {
    qty, notional,
    riskAmount: qty * perUnitLoss,
    riskPctReal: (qty * perUnitLoss) / capital * 100,
    capped,
    belowMin: notional < 5, // Binance exige un mínimo aprox. de 5 USDT por orden
  };
}

export function dailyLossStatus(trades, capital, maxDailyLossPct, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const pnl = trades.filter((t) => t.date === today).reduce((s, t) => s + t.pnl, 0);
  const limit = -capital * maxDailyLossPct / 100;
  return { pnl, limit, blocked: pnl <= limit, remaining: pnl - limit };
}
