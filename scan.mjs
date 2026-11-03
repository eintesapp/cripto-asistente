// Escáner automático: se ejecuta cada 15 minutos en GitHub Actions (gratis),
// analiza el mercado con datos públicos de Binance, guarda los resultados en
// data/*.json (que lee la app) y envía alertas a Telegram.
// Uso local:  node scanner/scan.mjs   (variables opcionales: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, APP_URL)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runScan } from './scan.js';

const root = new URL('./', import.meta.url);
const path = (p) => new URL(p, root);
const readJSON = async (p, def) => { try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return def; } };

const cfg = await readJSON('config.json', {});
const APP_URL = process.env.APP_URL || (cfg.appUrl?.includes('TU-USUARIO') ? '' : cfg.appUrl) || '';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN, TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const COOLDOWN_H = { '5m': 2, '15m': 4, '1h': 12, '4h': 24, '1d': 72, evento: 6 };
const qRank = { baja: 0, media: 1, alta: 2 };
const now = Date.now();

const fmt = (x) => (x == null ? '-' : x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(text) {
  if (!TG_TOKEN || !TG_CHAT) { console.log('[Telegram no configurado]\n' + text + '\n'); return; }
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) console.error('Error Telegram', res.status, await res.text());
}

function signalMessage(s) {
  const icon = s.action === 'COMPRA' ? '🟢' : '🔴';
  const link = APP_URL ? `\n<a href="${APP_URL}#/senal/${s.symbol}/${s.timeframe}">Abrir análisis completo</a>` : '';
  return `${icon} <b>${s.action} ${s.symbol}</b> · ${s.timeframe} · calidad ${s.quality.toUpperCase()}${s.caution ? ' ⚠️ PRECAUCIÓN' : ''}
Precio: ${fmt(s.currentPrice)} | Entrada: ${fmt(s.entry)}
SL: ${fmt(s.sl)} | TP1: ${fmt(s.tp1)} | TP2: ${fmt(s.tp2)}
R/B: ${s.rr1.toFixed(1)} / ${s.rr2.toFixed(1)} · Puntuación técnica ${s.score}/10
• ${s.reasons.slice(0, 3).map(esc).join('\n• ')}${s.warnings.length ? '\n⚠️ ' + esc(s.warnings[0]) : ''}
<i>No es asesoría financiera. Usa siempre Stop Loss.</i>${link}`;
}

// 1-3. Escanear (mismo motor que la app)
let scan;
try {
  scan = await runScan({
    topN: cfg.topN || 30, extraSymbols: cfg.extraSymbols || [], exclude: cfg.exclude || [], timeframes: cfg.alertTimeframes || ['1h', '4h'],
    minRR: cfg.minRR || 2, bigDrop24hPct: cfg.bigDrop24hPct ?? -10,
  });
} catch (e) {
  console.error('No se pudo leer Binance:', e.message);
  console.error('Si el error es 451, Binance bloquea la región del servidor. Ver README → "Plan B".');
  process.exit(1);
}
const { signals, events, data } = scan;

// 4. Resultado real de las señales anteriores (¿tocaron TP o SL?)
const history = await readJSON('data/history.json', []);
for (const h of history.filter((x) => x.status === 'abierta')) {
  const c = data[h.symbol]?.[h.timeframe];
  if (c && !c.error) {
    const long = h.action === 'COMPRA';
    for (let i = 0; i < c.close.length; i++) {
      if (c.time[i] <= h.candleTime) continue;
      const hitSL = long ? c.low[i] <= h.sl : c.high[i] >= h.sl;
      const hitTP1 = long ? c.high[i] >= h.tp1 : c.low[i] <= h.tp1;
      const hitTP2 = long ? c.high[i] >= h.tp2 : c.low[i] <= h.tp2;
      if (!h.tp1Hit && hitSL) { h.status = 'SL'; h.resultR = -1; h.closedAt = c.closeTime[i]; break; }
      if (!h.tp1Hit && hitTP1) h.tp1Hit = true;
      if (h.tp1Hit && hitTP2) { h.status = 'TP2'; h.resultR = (h.rr1 + h.rr2) / 2; h.closedAt = c.closeTime[i]; break; }
      if (h.tp1Hit && (long ? c.low[i] <= h.entry : c.high[i] >= h.entry)) { h.status = 'TP1'; h.resultR = h.rr1 / 2; h.closedAt = c.closeTime[i]; break; }
    }
  }
  if (h.status === 'abierta' && now - h.generatedAt > 14 * 864e5) h.status = 'expirada';
}

// 5. Alertas (sin repetir la misma señal dentro del período de enfriamiento)
const state = await readJSON('data/state.json', { sent: {} });
for (const k of Object.keys(state.sent)) if (now - state.sent[k] > 7 * 864e5) delete state.sent[k];
const fresh = (key, hours) => !state.sent[key] || now - state.sent[key] > hours * 3600e3;
const minQ = qRank[cfg.alertMinQuality || 'media'];
const toAlert = signals.filter((s) => (s.action === 'COMPRA' || s.action === 'VENTA') && qRank[s.quality] >= minQ);
let sentCount = 0;
for (const s of toAlert) {
  const key = `${s.symbol}|${s.timeframe}|${s.action}`;
  if (!fresh(key, COOLDOWN_H[s.timeframe] || 12)) continue;
  state.sent[key] = now; sentCount++;
  await telegram(signalMessage(s));
  history.unshift({
    id: `${key}|${s.candleTime}`, symbol: s.symbol, timeframe: s.timeframe, action: s.action, quality: s.quality, score: s.score,
    entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, rr1: s.rr1, rr2: s.rr2, candleTime: s.candleTime, generatedAt: now,
    reasons: s.reasons.slice(0, 4), status: 'abierta',
  });
}
if (cfg.alertEvents !== false) {
  const important = events.filter((e) => e.type === 'caida' || e.type === 'tendencia' || (e.type === 'subida' && e.timeframe !== '15m'));
  const lines = [];
  for (const e of important) {
    const key = `ev|${e.symbol}|${e.timeframe}|${e.type}`;
    if (!fresh(key, COOLDOWN_H.evento)) continue;
    state.sent[key] = now;
    lines.push(`${e.type === 'caida' ? '🔻' : e.type === 'subida' ? '🔺' : '🔄'} <b>${e.symbol}</b> (${e.timeframe}): ${esc(e.text)}`);
  }
  if (lines.length) { sentCount++; await telegram(`<b>Eventos de mercado</b>\n${lines.slice(0, 15).join('\n')}${APP_URL ? `\n<a href="${APP_URL}">Abrir la app</a>` : ''}`); }
}
history.splice(cfg.historyMax || 500);

// 6. Guardar resultados para la app
await mkdir(path('data/'), { recursive: true });
const { data: _omit, ...publicScan } = scan;
publicScan.signals = signals.filter((s) => s.action !== 'ESPERAR' || s.score >= 4);
await writeFile(path('data/signals.json'), JSON.stringify(publicScan));
await writeFile(path('data/history.json'), JSON.stringify(history));
await writeFile(path('data/state.json'), JSON.stringify(state));
const m = scan.market;
console.log(`Listo: ${signals.length} análisis, ${toAlert.length} señales accionables, ${events.length} eventos, ${sentCount} mensajes enviados. Mercado ${m.mood} (${m.breadth?.toFixed(0)}% sobre EMA50 4h).`);
