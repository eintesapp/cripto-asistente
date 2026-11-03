// Prueba de punta a punta del bot con Binance y Telegram SIMULADOS (no usa red ni dinero).
// Ejecutar: node bot.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createBot } from './bot.mjs';
import { floorToStep, roundToTick } from './exchange.js';

let clock = Date.UTC(2026, 10, 3, 15, 0, 0);
const now = () => clock;
const SECRET = 'secreto-de-prueba';

// ---- Binance simulado (como el Testnet: su precio es distinto al real) ----
const bx = { price: 150, realPrice: 160.2, usdt: 50, sol: 0, orders: {}, lists: {}, nextId: 1, calls: [] };
function binance(url, init) {
  const u = new URL(url), q = u.searchParams, m = init?.method || 'GET', path = u.pathname;
  const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  const fail = (code, msg) => ({ ok: false, status: 400, json: async () => ({ code, msg }), text: async () => JSON.stringify({ code, msg }) });
  if (u.host === 'data-api.binance.vision') return ok({ symbol: q.get('symbol'), price: String(bx.realPrice) });
  if (q.has('signature')) {
    const sig = q.get('signature'); const p = new URLSearchParams(q); p.delete('signature');
    assert.equal(sig, createHmac('sha256', SECRET).update(p.toString()).digest('hex'), 'firma HMAC inválida');
    assert.equal(init.headers['X-MBX-APIKEY'], 'clave');
  }
  bx.calls.push(`${m} ${path}`);
  if (path === '/api/v3/time') return ok({ serverTime: clock + 1200 });
  if (path === '/api/v3/exchangeInfo') return ok({ symbols: [{ symbol: 'SOLUSDT', status: 'TRADING', baseAsset: 'SOL', quoteAsset: 'USDT', ocoAllowed: true,
    filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01000000' }, { filterType: 'LOT_SIZE', stepSize: '0.00100000', minQty: '0.001' }, { filterType: 'NOTIONAL', minNotional: '5.00000000' }] }] });
  if (path === '/api/v3/ticker/price') return ok({ price: String(bx.price) });
  if (path === '/api/v3/account') return ok({ balances: [{ asset: 'USDT', free: String(bx.usdt), locked: '0' }, { asset: 'SOL', free: String(bx.sol), locked: '0' }] });
  if (path === '/api/v3/order' && m === 'POST') {
    const id = bx.nextId++;
    if (q.get('side') === 'BUY') {
      const quote = +q.get('quoteOrderQty'); const qty = +(quote / bx.price).toFixed(3);
      const fee = +(qty * 0.001).toFixed(5);
      bx.usdt -= qty * bx.price; bx.sol += qty - fee;
      return ok({ orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(qty * bx.price), fills: [{ commission: String(fee), commissionAsset: 'SOL' }] });
    }
    const qty = +q.get('quantity'); assert.ok(qty <= bx.sol + 1e-9, 'vende más de lo que tiene');
    bx.sol -= qty; bx.usdt += qty * bx.price;
    return ok({ orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(qty * bx.price) });
  }
  if (path === '/api/v3/orderList/oco') {
    const tp = +q.get('abovePrice'), stop = +q.get('belowStopPrice'), lim = +q.get('belowPrice'), qty = q.get('quantity');
    if (!(lim < stop && stop < bx.price && bx.price < tp)) return fail(-1013, 'precios OCO inválidos');
    assert.equal(qty, floorToStep(+qty, '0.001'), 'cantidad sin redondear');
    assert.equal(q.get('aboveType'), 'LIMIT_MAKER'); assert.equal(q.get('belowType'), 'STOP_LOSS_LIMIT');
    const listId = bx.nextId++; const a = bx.nextId++, b = bx.nextId++;
    bx.orders[a] = { orderId: a, type: 'LIMIT_MAKER', status: 'NEW', price: tp, qty: +qty, executedQty: '0', cummulativeQuoteQty: '0' };
    bx.orders[b] = { orderId: b, type: 'STOP_LOSS_LIMIT', status: 'NEW', price: lim, qty: +qty, executedQty: '0', cummulativeQuoteQty: '0' };
    bx.lists[listId] = { orderListId: listId, listOrderStatus: 'EXECUTING', orders: [{ orderId: a }, { orderId: b }], tp, stop, lim };
    bx.sol -= +qty; // bloqueado por la OCO
    return ok({ orderListId: listId });
  }
  if (path === '/api/v3/orderList' && m === 'GET') return ok(bx.lists[q.get('orderListId')]);
  if (path === '/api/v3/orderList' && m === 'DELETE') {
    const l = bx.lists[q.get('orderListId')];
    if (!l || l.listOrderStatus === 'ALL_DONE') return fail(-2011, 'Unknown order sent.');
    l.listOrderStatus = 'ALL_DONE'; for (const o of l.orders) bx.orders[o.orderId].status = 'CANCELED';
    bx.sol += bx.orders[l.orders[0].orderId].qty;
    return ok({});
  }
  if (path === '/api/v3/order' && m === 'GET') return ok(bx.orders[q.get('orderId')]);
  return fail(-1, 'ruta no simulada ' + path);
}
function fillList(id, which) { // simula que el mercado toca TP o SL
  const l = bx.lists[id]; l.listOrderStatus = 'ALL_DONE';
  const [tpO, slO] = l.orders.map((o) => bx.orders[o.orderId]);
  const hit = which === 'tp' ? tpO : slO, other = which === 'tp' ? slO : tpO;
  hit.status = 'FILLED'; hit.executedQty = String(hit.qty); hit.cummulativeQuoteQty = String(hit.qty * hit.price); other.status = 'CANCELED';
  bx.usdt += hit.qty * hit.price;
}

// ---- Telegram simulado ----
const sent = [];
let updates = [];
function telegram(url, init) {
  const method = url.split('/').pop(); const body = JSON.parse(init.body);
  if (method === 'getUpdates') { const r = updates; updates = []; return { ok: true, json: async () => ({ ok: true, result: r }) }; }
  if (method === 'sendMessage') sent.push(body);
  return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
}
const fetchFn = async (url, init) => (String(url).includes('api.telegram.org') ? telegram(String(url), init) : binance(String(url), init));

const signal = (o = {}) => ({ symbol: 'SOLUSDT', timeframe: '1h', action: 'COMPRA', quality: 'media', score: 6.5, caution: false,
  entry: 160, sl: 156, tp1: 166, tp2: 172, reasons: ['EMAs alineadas al alza (9 > 21 > 50)', 'MACD positivo'], candleTime: clock, ...o });
let nextSignals = [signal()];
const scanFn = async () => ({ signals: nextSignals });

const statePath = '/tmp/bot-test-state.json';
rmSync(statePath, { force: true });
const env = { BINANCE_API_KEY: 'clave', BINANCE_API_SECRET: SECRET, BINANCE_MODE: 'testnet', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '777' };
const bot = createBot({ env, statePath, fetchFn, now, scanFn, log: () => {}, config: { orderUsdt: 7, maxDailyLossUsdt: 0.5 } });
const click = async (data, chat = 777) => { updates.push({ update_id: Math.floor(Math.random() * 1e6), callback_query: { id: 'q', data, message: { message_id: 1, text: 'propuesta', chat: { id: chat } } } }); await bot.poll(); };
const lastText = () => sent[sent.length - 1].text;
let n = 0; const ok = (name) => console.log(`✓ ${++n}. ${name}`);

await bot.exchange.syncTime();

// 1. Propuesta con botones
await bot.scanAndPropose();
assert.match(lastText(), /COMPRA SOLUSDT/); assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, 'buy:1');
ok('Propone la compra por Telegram con botones Sí/No');

// 2. La misma señal no se repite
const before = sent.length; await bot.scanAndPropose(); assert.equal(sent.length, before);
ok('No repite la misma señal');

// 3. Otra persona no puede operar
await click('buy:1', 999); assert.equal(bx.calls.filter((c) => c === 'POST /api/v3/order').length, 0);
ok('Ignora botones de chats no autorizados');

// 4. Confirmar → compra + OCO
await click('buy:1');
assert.match(lastText(), /Compra ejecutada/);
const tr = bot.state.trades[0];
assert.equal(tr.status, 'abierta'); assert.ok(tr.orderListId);
const l = bx.lists[tr.orderListId];
assert.ok(Math.abs(l.tp - 150 * (1 + 6 / 160)) < 0.02 && Math.abs(l.stop - 150 * (1 - 4 / 160)) < 0.02, `niveles ${l.tp} ${l.stop}`);
ok(`Compra a mercado y OCO con niveles proporcionales al precio real de compra (TP ${l.tp}, SL ${l.stop}, límite ${l.lim})`);

// 5. Responder dos veces no compra dos veces
await click('buy:1'); assert.equal(bx.calls.filter((c) => c === 'POST /api/v3/order').length, 1);
ok('Un doble toque no compra dos veces');

// 6. Con una operación abierta no propone otra
nextSignals = [signal({ symbol: 'ETHUSDT', candleTime: clock + 1 })]; const b2 = sent.length; await bot.scanAndPropose(); assert.equal(sent.length, b2);
ok('Respeta el máximo de operaciones abiertas');

// 7. Se toca el Take Profit
fillList(tr.orderListId, 'tp'); await bot.monitor();
assert.match(lastText(), /Take Profit/); assert.ok(tr.pnl > 0, 'ganancia ' + tr.pnl);
ok(`Detecta el Take Profit y reporta el resultado (+${tr.pnl.toFixed(3)} USDT)`);

// 8. El precio ya subió demasiado → no compra
clock += 60e3; bx.realPrice = 162; nextSignals = [signal({ candleTime: clock })];
await bot.scanAndPropose(); const pid = Object.keys(bot.state.proposals).at(-1);
await click(`buy:${pid}`); assert.match(lastText(), /ya subió/);
ok('Cancela si el precio se alejó de la entrada');

// 9. Propuesta vencida
bx.realPrice = 160.1; nextSignals = [signal({ candleTime: clock + 2 })]; await bot.scanAndPropose();
const pid2 = Object.keys(bot.state.proposals).at(-1); clock += 25 * 60e3;
await click(`buy:${pid2}`); assert.match(lastText(), /venció/);
ok('Los botones vencen a los 20 minutos');

// 10. Stop Loss y límite de pérdida diaria
nextSignals = [signal({ candleTime: clock })]; await bot.scanAndPropose();
await click(`buy:${Object.keys(bot.state.proposals).at(-1)}`);
const tr2 = bot.state.trades.at(-1); fillList(tr2.orderListId, 'sl'); bx.lists[tr2.orderListId].tp = 0;
bx.orders[bx.lists[tr2.orderListId].orders[1].orderId].cummulativeQuoteQty = String(+tr2.buyQuote - 0.6); // pérdida de 0,6
await bot.monitor(); assert.match(lastText(), /Stop Loss/); assert.ok(tr2.pnl < -0.5);
nextSignals = [signal({ candleTime: clock + 5 })]; const b3 = sent.length; await bot.scanAndPropose(); assert.equal(sent.length, b3);
ok('Registra el Stop Loss y deja de proponer al llegar al límite de pérdida diaria');

// 11. Al día siguiente vuelve; cierre manual con /cerrar
clock += 864e5; nextSignals = [signal({ candleTime: clock })]; await bot.scanAndPropose();
await click(`buy:${Object.keys(bot.state.proposals).at(-1)}`);
const tr3 = bot.state.trades.at(-1);
updates.push({ update_id: 9e6, message: { text: '/cerrar', chat: { id: 777 } } }); await bot.poll();
assert.equal(sent.at(-1).reply_markup.inline_keyboard[0][0].callback_data, `close:${tr3.id}`);
await click(`close:${tr3.id}`); assert.match(lastText(), /cerrada/); assert.equal(tr3.status, 'cerrada');
assert.equal(bx.lists[tr3.orderListId].listOrderStatus, 'ALL_DONE');
ok('Cierre manual: cancela la OCO y vende a mercado');

// 12. Señal de VENTA sobre una posición abierta → pregunta si cerrar
nextSignals = [signal({ candleTime: clock + 9 })]; await bot.scanAndPropose(); await click(`buy:${Object.keys(bot.state.proposals).at(-1)}`);
nextSignals = [signal({ action: 'VENTA', candleTime: clock + 10, reasons: ['EMAs a la baja'] })]; await bot.scanAndPropose();
assert.match(sent.at(-1).text, /Señal de VENTA en SOLUSDT/);
ok('Pregunta si cerrar cuando aparece una VENTA de la moneda que tienes');

// 13. Límite de tiempo
clock += 49 * 36e5; await bot.monitor(); assert.match(lastText(), /límite de tiempo/);
ok('Avisa cuando una operación llega a su límite de tiempo');

// 14. Monto demasiado chico para el mínimo de Binance
const small = createBot({ env, statePath: '/tmp/bot-test-2.json', fetchFn, now, scanFn, log: () => {}, config: { orderUsdt: 5 } });
rmSync('/tmp/bot-test-2.json', { force: true });
const r = await small.executeBuy({ id: 'x', symbol: 'SOLUSDT', timeframe: '1h', entry: 160, sl: 156, tp: 166, slPct: 0.025, tpPct: 0.0375, amount: 5, createdAt: clock });
assert.match(r.msg, /muy chico/);
ok('Rechaza montos que dejarían el Stop Loss bajo el mínimo de Binance');

// 15. Redondeo
assert.equal(floorToStep(0.0466999, '0.00100000'), '0.046'); assert.equal(roundToTick(146.2549, '0.01000000'), '146.25');
ok('Redondea cantidades y precios según las reglas de Binance');

// 16. /pausa
updates.push({ update_id: 9e6 + 1, message: { text: '/pausa', chat: { id: 777 } } }); await bot.poll();
assert.equal(bot.state.paused, true);
ok('Comando /pausa');

console.log(`\n${n} pruebas del bot OK`);
