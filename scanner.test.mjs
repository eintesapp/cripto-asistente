// Prueba de punta a punta del escáner con un Binance simulado (sin red).
// Ejecutar: node test/scanner.test.mjs
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'scan-'));
for (const p of ['engine', 'scanner', 'config.json', 'package.json']) await cp(new URL('../' + p, import.meta.url), join(dir, p), { recursive: true });

const MS = { '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '5m': 3e5 };
let seed = 3; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const sent = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  const json = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (url.includes('api.telegram.org')) { sent.push(JSON.parse(init.body).text); return json({ ok: true }); }
  if (url.includes('/ticker/24hr')) return json(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'USDCUSDT', 'XRPUSDT'].map((s, k) => ({ symbol: s, lastPrice: '100', priceChangePercent: k === 4 ? '-12.5' : '1.2', quoteVolume: String(1e9 / (k + 1)), highPrice: '110', lowPrice: '90', count: 1000 })));
  if (url.includes('/klines')) {
    const iv = new URL(url).searchParams.get('interval'), lim = +new URL(url).searchParams.get('limit');
    const step = MS[iv]; let p = 100; const out = []; const t0 = Math.floor(Date.now() / step) * step - (lim - 1) * step;
    for (let i = 0; i < lim; i++) { const o = p, c = o * (1 + 0.002 + (rand() - 0.5) * 0.02); out.push([t0 + i * step, o, Math.max(o, c) * 1.003, Math.min(o, c) * 0.997, c, 1000 * (rand() < 0.1 ? 5 : 1), t0 + (i + 1) * step - 1, 1e5, 10]); p = c; }
    return json(out);
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
process.env.TELEGRAM_BOT_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = '1'; process.env.APP_URL = 'https://ejemplo.github.io/app/';
const log = console.log; console.log = () => {};
await import(join(dir, 'scanner/scan.mjs'));
console.log = log;
const out = JSON.parse(await readFile(join(dir, 'data/signals.json'), 'utf8'));
const hist = JSON.parse(await readFile(join(dir, 'data/history.json'), 'utf8'));
if (out.pairs.some((p) => p.symbol === 'USDCUSDT')) throw new Error('no debe incluir stablecoins');
if (!out.market || !out.market.majors.length) throw new Error('falta resumen de mercado');
if (!out.events.some((e) => e.type === 'caida' && e.symbol === 'XRPUSDT')) throw new Error('debe detectar la caída de XRP');
console.log(`✓ escáner OK: ${out.pairs.length} pares, ${out.signals.length} señales guardadas, ${hist.length} en historial, ${sent.length} mensajes Telegram, mercado ${out.market.mood}`);
console.log('--- ejemplo de mensaje ---\n' + (sent.find((m) => m.includes('COMPRA') || m.includes('VENTA')) || sent[0]));
