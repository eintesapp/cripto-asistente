// Escaneo completo del mercado. Lo usan tanto la app (en el celular) como el
// escáner automático (GitHub Actions), así ambos dan exactamente las mismas señales.
import { tickers24h, topUsdtPairs, klines, pool, HIGHER_TF } from './binance.js';
import { computeIndicators, trendAt, analyzeSeries } from './signals.js';

export async function runScan({ topN = 30, extraSymbols = [], exclude = [], timeframes = ['1h', '4h'], minRR = 2, bigDrop24hPct = -10, onProgress } = {}) {
  const now = Date.now();
  const tickers = await tickers24h();
  const top = topUsdtPairs(tickers, topN, 5e6, exclude);
  for (const sym of extraSymbols) {
    if (top.find((t) => t.symbol === sym)) continue;
    const t = tickers.find((x) => x.symbol === sym);
    if (t) top.push({ symbol: sym, base: sym.replace(/USDT$/, ''), price: +t.lastPrice, change24h: +t.priceChangePercent, quoteVolume: +t.quoteVolume });
  }
  for (const s of ['BTCUSDT', 'ETHUSDT']) {
    if (!top.find((t) => t.symbol === s)) {
      const t = tickers.find((x) => x.symbol === s);
      if (t) top.unshift({ symbol: s, base: s.slice(0, -4), price: +t.lastPrice, change24h: +t.priceChangePercent, quoteVolume: +t.quoteVolume });
    }
  }
  const tfs = [...new Set([...timeframes, ...timeframes.map((t) => HIGHER_TF[t]), '4h', '1d'])];
  const jobs = top.flatMap((t) => tfs.map((tf) => ({ symbol: t.symbol, tf })));
  const data = {};
  let done = 0;
  await pool(jobs, async ({ symbol, tf }) => {
    try { (data[symbol] ||= {})[tf] = await klines(symbol, tf, 300); }
    finally { done++; onProgress?.(done, jobs.length); }
  }, 6);

  const ok = (c) => c && !c.error && c.close && c.close.length >= 60;
  const signals = [], events = [];
  for (const t of top) {
    for (const tf of timeframes) {
      const c = data[t.symbol]?.[tf];
      if (!ok(c)) continue;
      const htf = data[t.symbol]?.[HIGHER_TF[tf]];
      const { signal } = analyzeSeries(c, { symbol: t.symbol, timeframe: tf, opts: { minRR } }, ok(htf) ? htf : null);
      signal.change24h = t.change24h;
      delete signal.fib;
      signals.push(signal);
      for (const e of signal.events) events.push({ symbol: t.symbol, timeframe: tf, ...e, time: now });
    }
    if (t.change24h <= bigDrop24hPct) events.push({ symbol: t.symbol, timeframe: '24h', type: 'caida', text: `Caída de ${t.change24h.toFixed(1)}% en 24 h`, time: now });
    if (t.change24h >= Math.abs(bigDrop24hPct) * 1.5) events.push({ symbol: t.symbol, timeframe: '24h', type: 'subida', text: `Subida de ${t.change24h.toFixed(1)}% en 24 h (cuidado con perseguir el precio)`, time: now });
  }

  // Estado general: qué % de las principales monedas está sobre su EMA 50 en 4h
  let above = 0, counted = 0;
  for (const t of top) {
    const c = data[t.symbol]?.['4h'];
    if (!ok(c)) continue;
    const ind = computeIndicators(c), i = c.close.length - 1;
    if (ind.ema50[i] != null) { counted++; if (c.close[i] > ind.ema50[i]) above++; }
  }
  const trendOf = (s, tf) => { const c = data[s]?.[tf]; return ok(c) ? trendAt(c, computeIndicators(c), c.close.length - 1) : 'n/d'; };
  const breadth = counted ? (above / counted) * 100 : null;
  const majors = ['BTCUSDT', 'ETHUSDT'].map((s) => {
    const t = tickers.find((x) => x.symbol === s);
    return { symbol: s, price: +t?.lastPrice, change24h: +t?.priceChangePercent, trend4h: trendOf(s, '4h'), trend1d: trendOf(s, '1d') };
  });
  const mood = breadth == null ? 'n/d' : breadth >= 60 ? 'alcista' : breadth <= 40 ? 'bajista' : 'mixto';

  return {
    generatedAt: now,
    market: { mood, breadth, breadthTf: '4h', majors },
    pairs: top.map(({ symbol, price, change24h, quoteVolume }) => ({ symbol, price, change24h, quoteVolume })),
    signals, events, data,
  };
}
