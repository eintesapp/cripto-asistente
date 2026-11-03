// Indicadores técnicos. Funciones puras: reciben arrays y devuelven arrays
// del mismo largo (con null donde aún no hay datos suficientes).
// Funcionan igual en el navegador y en Node.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period; // se inicia con la SMA (convención estándar)
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI de Wilder
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const sig = new Array(closes.length).fill(null);
  if (start >= 0) {
    const sub = ema(line.slice(start), signal);
    sub.forEach((v, j) => (sig[start + j] = v));
  }
  const hist = line.map((v, i) => (v != null && sig[i] != null ? v - sig[i] : null));
  return { line, signal: sig, hist };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const width = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    width[i] = mid[i] ? (upper[i] - lower[i]) / mid[i] : null;
  }
  return { mid, upper, lower, width };
}

// ATR de Wilder: mide la volatilidad típica de cada vela. Se usa para el Stop Loss.
export function atr(highs, lows, closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  const tr = closes.map((c, i) =>
    i === 0 ? highs[i] - lows[i]
      : Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  if (closes.length <= period) return out;
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i];
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Pivotes (fractales): máximos/mínimos locales confirmados por `k` velas a cada lado.
// Solo usa velas ya cerradas hasta `end` (evita mirar el futuro).
export function pivots(highs, lows, k = 3, end = highs.length - 1) {
  const ph = [], pl = [];
  for (let i = k; i <= end - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (highs[i] <= highs[i - j] || highs[i] < highs[i + j]) isH = false;
      if (lows[i] >= lows[i - j] || lows[i] > lows[i + j]) isL = false;
    }
    if (isH) ph.push({ i, price: highs[i] });
    if (isL) pl.push({ i, price: lows[i] });
  }
  return { highs: ph, lows: pl };
}

// Agrupa pivotes cercanos (dentro de tol, en fracción del precio) en niveles.
// Un nivel tocado varias veces es más relevante.
export function levelsFromPivots(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const levels = [];
  for (const p of sorted) {
    const last = levels[levels.length - 1];
    if (last && Math.abs(p.price - last.price) / last.price <= tol) {
      last.touches++;
      last.price = (last.price * (last.touches - 1) + p.price) / last.touches;
      last.lastIndex = Math.max(last.lastIndex, p.i);
    } else {
      levels.push({ price: p.price, touches: 1, lastIndex: p.i });
    }
  }
  return levels;
}

// Retrocesos de Fibonacci del último gran tramo (máximo y mínimo de las últimas `lookback` velas).
export function fibonacci(highs, lows, lookback = 120, end = highs.length - 1) {
  const from = Math.max(0, end - lookback + 1);
  let hi = -Infinity, lo = Infinity, hiI = from, loI = from;
  for (let i = from; i <= end; i++) {
    if (highs[i] > hi) { hi = highs[i]; hiI = i; }
    if (lows[i] < lo) { lo = lows[i]; loI = i; }
  }
  const up = loI < hiI; // tramo alcista: primero el mínimo, luego el máximo
  const range = hi - lo;
  const ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
  const levels = ratios.map((r) => ({ ratio: r, price: up ? hi - range * r : lo + range * r }));
  const ext = up ? hi + range * 0.618 : lo - range * 0.618; // extensión 1.618
  return { high: hi, low: lo, direction: up ? 'alcista' : 'bajista', levels, extension1618: ext };
}
