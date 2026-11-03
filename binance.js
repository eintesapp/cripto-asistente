// Acceso a datos PÚBLICOS de Binance (no requiere claves ni permisos de cuenta).
// data-api.binance.vision es el endpoint oficial de solo datos de mercado.
// Si falla, se intenta con api.binance.com.

const BASES = ['https://data-api.binance.vision', 'https://api.binance.com'];

const STABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'DAI', 'EUR', 'AEUR', 'EURI', 'USDE', 'XUSD', 'USD1', 'BFUSD', 'PAXG', 'RLUSD', 'USDS']);

export const TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
// Temporalidad superior usada para confirmar la tendencia.
export const HIGHER_TF = { '5m': '1h', '15m': '4h', '1h': '4h', '4h': '1d', '1d': '1d' };

let preferred = 0;

async function get(path, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (let b = 0; b < BASES.length; b++) {
      const base = BASES[(preferred + b) % BASES.length];
      try {
        const res = await fetch(base + path);
        if (res.status === 429 || res.status === 418) {
          // Límite de peticiones: esperar y reintentar
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          lastErr = new Error('Binance: límite de peticiones (' + res.status + ')');
          continue;
        }
        if (res.status === 451) { lastErr = new Error('Binance bloquea esta región (451)'); continue; }
        if (!res.ok) { lastErr = new Error('Binance HTTP ' + res.status); continue; }
        preferred = (preferred + b) % BASES.length;
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

export async function klines(symbol, interval, limit = 300) {
  const raw = await get(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return parseKlines(raw);
}

export function parseKlines(raw, now = Date.now()) {
  const c = { time: [], open: [], high: [], low: [], close: [], volume: [], quoteVolume: [], closeTime: [] };
  for (const k of raw) {
    c.time.push(k[0]); c.open.push(+k[1]); c.high.push(+k[2]); c.low.push(+k[3]);
    c.close.push(+k[4]); c.volume.push(+k[5]); c.closeTime.push(k[6]); c.quoteVolume.push(+k[7]);
  }
  // La última vela normalmente sigue abierta: se guarda el precio actual
  // pero las señales se calculan solo con velas CERRADAS.
  const lastOpen = c.closeTime.length && c.closeTime[c.closeTime.length - 1] > now;
  c.lastPrice = c.close[c.close.length - 1];
  if (lastOpen) for (const key of ['time', 'open', 'high', 'low', 'close', 'volume', 'quoteVolume', 'closeTime']) c[key].pop();
  return c;
}

export async function tickers24h() {
  return get('/api/v3/ticker/24hr');
}

// Pares USDT con más volumen, sin stablecoins ni tokens apalancados.
export function topUsdtPairs(tickers, n = 30, minQuoteVolume = 5e6) {
  return tickers
    .filter((t) => t.symbol.endsWith('USDT'))
    .filter((t) => {
      const base = t.symbol.slice(0, -4);
      return !STABLES.has(base) && !/(UP|DOWN|BULL|BEAR)$/.test(base) && +t.quoteVolume >= minQuoteVolume && +t.count > 0;
    })
    .sort((a, b) => +b.quoteVolume - +a.quoteVolume)
    .slice(0, n)
    .map((t) => ({
      symbol: t.symbol,
      base: t.symbol.slice(0, -4),
      price: +t.lastPrice,
      change24h: +t.priceChangePercent,
      quoteVolume: +t.quoteVolume,
      high: +t.highPrice,
      low: +t.lowPrice,
    }));
}

// Ejecuta tareas con concurrencia limitada (para respetar los límites de Binance).
export async function pool(items, worker, concurrency = 6) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await worker(items[i], i); } catch (e) { results[i] = { error: String(e.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// Historial largo (más de 1000 velas) paginando hacia atrás. Para backtesting.
export async function klinesHistory(symbol, interval, total = 2000) {
  let all = [];
  let endTime = '';
  while (all.length < total) {
    const lim = Math.min(1000, total - all.length);
    const raw = await get(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${lim}${endTime}`);
    if (!raw.length) break;
    all = raw.concat(all);
    endTime = `&endTime=${raw[0][0] - 1}`;
    if (raw.length < lim) break;
  }
  return parseKlines(all);
}
