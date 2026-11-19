// Prueba de punta a punta del bot v2 (Ruptura 55 diaria) con Binance y Telegram SIMULADOS.
// Ejecutar: node bot.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const T = (f) => join(tmpdir(), f);
import { createBot } from './bot.mjs';
import { parseKlines } from './binance.js';
import { breakoutSignal } from './tendencia.js';

const DAY = 864e5;
let clock = Date.UTC(2026, 10, 7, 2, 0, 0); // 23:00 Chile, la vela diaria del 6-nov ya cerró
const now = () => clock;
const SECRET = 'secreto';

// ---------- Velas diarias simuladas ----------
// SOL: sube 200 días, lateral 60 días con techo 150 y rompe el último día. Las demás: lateral sin ruptura.
const START = Date.UTC(2026, 10, 7) - 270 * DAY; // última vela cerrada: 6-nov
const extra = {}; // velas futuras por símbolo (para simular días siguientes)
function base(symbol) {
  const raw = []; let p = 100;
  for (let d = 0; d < 270; d++) {
    const t = START + d * DAY;
    let o = p, c;
    if (symbol === 'SOLUSDT') {
      if (d < 200) c = o * 1.0025;
      else if (d < 269) c = 146 + Math.sin(d) * 3;
      else c = 156;
    } else c = 100 + Math.sin(d / 3) * 2;
    const h = Math.min(Math.max(o, c) * 1.01, symbol === 'SOLUSDT' && d >= 200 && d < 269 ? 150 : Infinity), l = Math.min(o, c) * 0.99;
    raw.push([t, o, Math.max(h, o, c), l, c, 1000, t + DAY - 1, 1e5, 10]); p = c;
  }
  return raw.concat(extra[symbol] || []);
}
const klinesFn = async (symbol, interval, limit) => parseKlines(base(symbol).filter((k) => k[6] < clock).slice(-limit), clock);
function addDay(symbol, o, h, l, c) {
  for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) { // todas las monedas reciben su vela del día
    const t = base(s).at(-1)[0] + DAY;
    const k = s === symbol ? [o, h, l, c] : [100, 101, 99, 100];
    (extra[s] ||= []).push([t, ...k, 1000, t + DAY - 1, 1e5, 10]);
  }
}

// ---------- Binance simulado (como Testnet: precio distinto al real) ----------
const bx = { price: 120, real: 156, usdt: 50, sol: 0, orders: {}, nextId: 1, posts: [] };
function binance(url, init) {
  const u = new URL(url), q = u.searchParams, m = init?.method || 'GET', path = u.pathname;
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const fail = (code, msg) => ({ ok: false, status: 400, json: async () => ({ code, msg }), text: async () => JSON.stringify({ code, msg }) });
  if (u.host === 'data-api.binance.vision') return ok({ price: String(bx.real) });
  if (q.has('signature')) { const sig = q.get('signature'); const p = new URLSearchParams(q); p.delete('signature'); assert.equal(sig, createHmac('sha256', SECRET).update(p.toString()).digest('hex')); }
  if (path === '/api/v3/time') return ok({ serverTime: clock });
  if (path === '/api/v3/exchangeInfo') return ok({ symbols: [{ status: 'TRADING', baseAsset: 'SOL', quoteAsset: 'USDT', orderTypes: ['LIMIT', 'MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT'], filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }, { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }, { filterType: 'NOTIONAL', minNotional: '5' }] }] });
  if (path === '/api/v3/account') return ok({ balances: [{ asset: 'USDT', free: String(bx.usdt), locked: '0' }, { asset: 'SOL', free: String(bx.sol), locked: '0' }] });
  if (path === '/api/v3/order' && m === 'POST') {
    const id = bx.nextId++, type = q.get('type'); bx.posts.push(type);
    if (type === 'MARKET' && q.get('side') === 'BUY') {
      const quote = +q.get('quoteOrderQty'), qty = +(quote / bx.price).toFixed(3), fee = +(qty * 0.001).toFixed(6);
      bx.usdt -= qty * bx.price; bx.sol += qty - fee;
      return ok({ orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(qty * bx.price), fills: [{ commission: String(fee), commissionAsset: 'SOL' }] });
    }
    if (type === 'MARKET') { const qty = +q.get('quantity'); assert.ok(qty <= bx.sol + 1e-9); bx.sol -= qty; bx.usdt += qty * bx.price; return ok({ orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(qty * bx.price) }); }
    if (type === 'STOP_LOSS') {
      const stop = +q.get('stopPrice'), qty = +q.get('quantity');
      if (stop >= bx.price) return fail(-2010, 'Stop price would trigger immediately.');
      assert.ok(qty <= bx.sol + 1e-9, 'stop por más de lo disponible');
      bx.sol -= qty; bx.orders[id] = { orderId: id, type, status: 'NEW', stopPrice: stop, qty, executedQty: '0', cummulativeQuoteQty: '0' };
      return ok({ orderId: id });
    }
  }
  if (path === '/api/v3/order' && m === 'DELETE') { const o = bx.orders[q.get('orderId')]; if (!o || o.status !== 'NEW') return fail(-2011, 'Unknown order sent.'); o.status = 'CANCELED'; bx.sol += o.qty; return ok({}); }
  if (path === '/api/v3/order' && m === 'GET') return ok(bx.orders[q.get('orderId')]);
  return fail(-1, 'ruta no simulada ' + m + ' ' + path);
}
function triggerStop() { const o = Object.values(bx.orders).find((x) => x.status === 'NEW'); o.status = 'FILLED'; o.executedQty = String(o.qty); o.cummulativeQuoteQty = String(o.qty * o.stopPrice); bx.usdt += o.qty * o.stopPrice; return o; }

// ---------- Telegram simulado ----------
const sent = []; let updates = [];
function telegram(url, init) {
  const method = url.split('/').pop(), body = JSON.parse(init.body);
  if (method === 'getUpdates') { const r = updates; updates = []; return { ok: true, json: async () => ({ ok: true, result: r }) }; }
  if (method === 'sendMessage') sent.push(body);
  return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
}
const fetchFn = async (url, init) => (String(url).includes('api.telegram.org') ? telegram(String(url), init) : binance(String(url), init));

const env = { BINANCE_API_KEY: 'k', BINANCE_API_SECRET: SECRET, BINANCE_MODE: 'testnet', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '777' };
const statePath = T('bot-v2-test.json'); rmSync(statePath, { force: true });
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const bot = createBot({ env, statePath, fetchFn, now, klinesFn, log: () => {}, config: { symbols: SYMS } });
let uid = 1;
const click = async (data, chat = 777) => { updates.push({ update_id: uid++, callback_query: { id: 'q', data, message: { message_id: 1, text: 'x', chat: { id: chat } } } }); await bot.poll(); };
const cmd = async (text) => { updates.push({ update_id: uid++, message: { text, chat: { id: 777 } } }); await bot.poll(); };
const last = () => sent.at(-1).text;
let n = 0; const ok = (s) => console.log(`✓ ${++n}. ${s}`);

// 0. La señal de la estrategia
const sig = breakoutSignal(await klinesFn('SOLUSDT', '1d', 300));
assert.ok(sig && sig.close === 156, 'debe detectar la ruptura de SOL');
assert.equal(breakoutSignal(await klinesFn('BTCUSDT', '1d', 300)), null);
ok(`Detecta la ruptura de 55 velas (SOL cierra 156 > techo 150; stop inicial −${(sig.slPct * 100).toFixed(1)}%)`);

// 1. Revisión diaria → propuesta solo de SOL
const r1 = await bot.dailyCycle();
const prop = sent.find((m) => /RUPTURA SOLUSDT/.test(m.text));
assert.equal(r1.found, 1); assert.ok(prop); assert.equal(prop.reply_markup.inline_keyboard[0][0].callback_data, 'buy:1');
ok('Revisión diaria propone solo la moneda con ruptura, con botones Sí/No');

// 1b. Resumen nocturno después de la revisión
assert.match(last(), /Revisión diaria/); assert.match(last(), /Revisé 3 criptos\. Señales nuevas: <b>1<\/b>/); assert.match(last(), /Más cerca de dar señal/);
assert.equal(sent.at(-1).reply_markup, undefined);
const nAntes = sent.length;
ok('Envía el resumen diario (criptos revisadas, señales y las más cercanas)');

// 2. No repite el mismo día
assert.equal((await bot.dailyCycle()).skipped, true);
assert.equal(sent.length, nAntes);
ok('No vuelve a revisar la misma vela diaria ni repite el resumen');

// 3. Tamaño de posición
const z50 = bot.sizing({ capital: 50, freeUsdt: 50, slPct: 0.12, minNotional: 5 });
assert.ok(z50.ok && z50.amount >= 6.5 && z50.amount <= 6.6 && z50.riskPctOfCapital < 2, JSON.stringify(z50));
const z11 = bot.sizing({ capital: 11, freeUsdt: 11, slPct: 0.12, minNotional: 5 });
assert.ok(z11.ok && z11.riskPctOfCapital > 7);
const z300 = bot.sizing({ capital: 300, freeUsdt: 300, slPct: 0.12, minNotional: 5 });
assert.equal(z300.amount, 15); // tope maxOrderUsdt
assert.equal(bot.sizing({ capital: 4, freeUsdt: 4, slPct: 0.12, minNotional: 5 }).ok, false);
ok(`Tamaño por riesgo: con 50 USDT compra ${z50.amount} y arriesga ${z50.riskPctOfCapital.toFixed(1)}%; con 11 USDT arriesga ${z11.riskPctOfCapital.toFixed(1)}%; respeta tope y mínimo`);

// 4. Chat no autorizado
await click('buy:1', 999); assert.equal(bx.posts.length, 0);
ok('Ignora botones de otros chats');

// 5. Comprar
await click('buy:1');
assert.match(last(), /Compra ejecutada/);
const tr = bot.state.trades.at(-1);
assert.ok(tr.stopOrderId && bx.orders[tr.stopOrderId].type === 'STOP_LOSS');
const expectStop = 120 * (1 - sig.slPct);
assert.ok(Math.abs(tr.stopPrice - expectStop) / expectStop < 0.01, `stop ${tr.stopPrice} vs ${expectStop}`);
ok(`Compra a mercado y pone STOP_LOSS en Binance (${tr.stopPrice}, proporcional al precio real)`);

// 6. Doble toque no compra dos veces
await click('buy:1'); assert.equal(bx.posts.filter((x) => x === 'MARKET').length, 1);
ok('Un doble toque no compra dos veces');

// 7. Día siguiente: SOL sube → el stop sube
addDay('SOLUSDT', 156, 175, 155, 172); clock += DAY; bx.real = 172; bx.price = 132;
const before = tr.stopPrice;
await bot.dailyCycle();
assert.ok(tr.stopPrice > before, `stop debió subir: ${before} → ${tr.stopPrice}`);
assert.equal(Object.values(bx.orders).filter((o) => o.status === 'NEW').length, 1);
assert.match(sent.map((m) => m.text).join('\n'), /stop subido/);
ok(`Al día siguiente sube el stop (${before} → ${tr.stopPrice}) y deja una sola orden activa`);

// 8. Día con baja: el stop NO baja
addDay('SOLUSDT', 172, 173, 160, 162); clock += DAY; bx.real = 162; bx.price = 125;
const s2 = tr.stopPrice; await bot.dailyCycle(); assert.equal(tr.stopPrice, s2);
ok('Si el precio baja, el stop no se mueve');

// 9. /estado
await cmd('/estado'); assert.match(last(), /SOLUSDT: compra .* stop/);
ok('/estado muestra la operación y su stop');

// 10. Se ejecuta el stop
const o = triggerStop(); await bot.monitor();
assert.equal(tr.status, 'cerrada'); assert.match(last(), /cerrada por el stop/);
ok(`Detecta la ejecución del stop y reporta el resultado (${tr.pnl.toFixed(2)} USDT)`);

// 11. Precio movido: cancela
await cmd('/prueba sol'); const pid = Object.keys(bot.state.proposals).at(-1);
bx.real = bot.state.proposals[pid].close * 1.03; await click(`buy:${pid}`); assert.match(last(), /ya subió/);
ok('Cancela si el precio se alejó más de 2% de la señal');

// 12. Cierre manual
bx.real = 160; bx.price = 125; await cmd('/prueba sol'); await click(`buy:${Object.keys(bot.state.proposals).at(-1)}`);
const tr2 = bot.state.trades.at(-1); assert.equal(tr2.status, 'abierta');
await cmd('/cerrar'); await click(`close:${tr2.id}`);
assert.equal(tr2.status, 'cerrada'); assert.equal(bx.orders[tr2.stopOrderId].status, 'CANCELED');
ok('Cierre manual: cancela el stop y vende a mercado');

// 13. Precio bajo el nuevo stop al revisar → cierra a mercado
await cmd('/prueba sol'); await click(`buy:${Object.keys(bot.state.proposals).at(-1)}`);
const tr3 = bot.state.trades.at(-1);
addDay('SOLUSDT', 160, 230, 158, 228); clock += DAY; bx.real = 150; bx.price = 118;
const m0 = sent.length; await bot.dailyCycle(); assert.equal(tr3.status, 'cerrada'); assert.match(sent.slice(m0).map((m) => m.text).join('\n'), /cerrada/);
ok('Si el precio ya está bajo el nuevo stop, cierra a mercado');

// 14. Máximo de operaciones abiertas
const b2 = createBot({ env, statePath: T('bot-v2-b.json'), fetchFn, now, klinesFn, log: () => {}, config: { symbols: SYMS, maxOpenTrades: 0 } });
rmSync(T('bot-v2-b.json'), { force: true });
const r = await b2.executeBuy({ id: 'x', symbol: 'SOLUSDT', close: 150, atr: 5, slPct: 0.08, createdAt: clock });
assert.match(r.msg, /operaciones abiertas/);
ok('Respeta el máximo de operaciones abiertas');

// 15. /prueba bloqueado en real
const real = createBot({ env: { ...env, BINANCE_MODE: 'real' }, statePath: T('bot-v2-c.json'), fetchFn, now, klinesFn, log: () => {}, config: { symbols: SYMS } });
rmSync(T('bot-v2-c.json'), { force: true });
updates.push({ update_id: uid++, message: { text: '/prueba', chat: { id: 777 } } }); await real.poll(); assert.match(last(), /solo funciona en modo TESTNET/);
ok('/prueba está desactivado en modo real');

console.log(`\n${n} pruebas del bot v2 OK`);
