// Cliente FIRMADO de Binance Spot para operar (solo se usa en el servidor del bot).
// Las claves vienen de variables de entorno; nunca se escriben en el código.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const BASES = {
  testnet: 'https://testnet.binance.vision', // dinero ficticio
  real: 'https://api.binance.com',
};

export function createExchange({ apiKey, apiSecret, mode = 'testnet', fetchFn = globalThis.fetch, now = () => Date.now(), paperPath = 'papel-estado.json', paperStartUsdt = 50 }) {
  mode = String(mode || 'testnet').trim().toLowerCase();
  if (mode === 'papel') return createPaperExchange({ fetchFn, now, path: paperPath, startUsdt: paperStartUsdt });
  apiKey = String(apiKey || '').trim(); apiSecret = String(apiSecret || '').trim();
  if (!BASES[mode]) throw new Error('BINANCE_MODE debe ser "papel", "testnet" o "real"');
  const base = BASES[mode];
  let offset = 0; // diferencia entre el reloj del servidor y el de Binance
  const filtersCache = {};

  async function call(method, path, params = {}, signed = false) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) p.append(k, String(v));
    if (signed) {
      p.append('recvWindow', '10000');
      p.append('timestamp', String(Math.round(now() + offset)));
      p.append('signature', createHmac('sha256', apiSecret).update(p.toString()).digest('hex'));
    }
    const url = `${base}${path}${p.toString() ? '?' + p : ''}`;
    const res = await fetchFn(url, { method, headers: signed ? { 'X-MBX-APIKEY': apiKey } : {} });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      const err = new Error(`Binance ${res.status}: ${body?.msg || text}`);
      err.code = body?.code; err.status = res.status;
      throw err;
    }
    return body;
  }

  return {
    mode,
    async syncTime() {
      const t = await call('GET', '/api/v3/time');
      offset = t.serverTime - now();
      return offset;
    },
    async filters(symbol) {
      if (filtersCache[symbol]) return filtersCache[symbol];
      const info = await call('GET', '/api/v3/exchangeInfo', { symbol });
      const s = info.symbols?.[0];
      if (!s) throw new Error(`Par ${symbol} no disponible en Binance ${mode}`);
      const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
      const out = {
        status: s.status,
        base: s.baseAsset, quote: s.quoteAsset,
        tickSize: f.PRICE_FILTER?.tickSize || '0.00000001',
        stepSize: f.LOT_SIZE?.stepSize || '0.00000001',
        minQty: +(f.LOT_SIZE?.minQty || 0),
        minNotional: +(f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || 5),
        ocoAllowed: s.ocoAllowed !== false,
        orderTypes: s.orderTypes || [],
      };
      filtersCache[symbol] = out;
      return out;
    },
    async price(symbol) { return +(await call('GET', '/api/v3/ticker/price', { symbol })).price; },
    async balances() {
      const a = await call('GET', '/api/v3/account', { omitZeroBalances: true }, true);
      return Object.fromEntries(a.balances.map((b) => [b.asset, { free: +b.free, locked: +b.locked }]));
    },
    marketBuy(symbol, quoteQty) {
      return call('POST', '/api/v3/order', { symbol, side: 'BUY', type: 'MARKET', quoteOrderQty: quoteQty, newOrderRespType: 'FULL' }, true);
    },
    marketSell(symbol, quantity) {
      return call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'MARKET', quantity, newOrderRespType: 'FULL' }, true);
    },
    // OCO de venta: Take Profit (límite) arriba y Stop Loss abajo. Si se ejecuta uno, Binance cancela el otro.
    ocoSell(symbol, { quantity, takeProfit, stopPrice, stopLimit }) {
      return call('POST', '/api/v3/orderList/oco', {
        symbol, side: 'SELL', quantity,
        aboveType: 'LIMIT_MAKER', abovePrice: takeProfit,
        belowType: 'STOP_LOSS_LIMIT', belowStopPrice: stopPrice, belowPrice: stopLimit, belowTimeInForce: 'GTC',
        newOrderRespType: 'FULL',
      }, true);
    },
    // Stop Loss de venta. STOP_LOSS = se vende a mercado al tocar el precio (no se queda sin ejecutar si el precio salta).
    // Si el par no lo permite, usa STOP_LOSS_LIMIT con un límite 2% más abajo.
    stopSell(symbol, { quantity, stopPrice, limitPrice, market = true }) {
      return market
        ? call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'STOP_LOSS', quantity, stopPrice }, true)
        : call('POST', '/api/v3/order', { symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT', quantity, stopPrice, price: limitPrice, timeInForce: 'GTC' }, true);
    },
    cancelOrder(symbol, orderId) { return call('DELETE', '/api/v3/order', { symbol, orderId }, true); },
    orderList(orderListId) { return call('GET', '/api/v3/orderList', { orderListId }, true); },
    order(symbol, orderId) { return call('GET', '/api/v3/order', { symbol, orderId }, true); },
    cancelOrderList(symbol, orderListId) { return call('DELETE', '/api/v3/orderList', { symbol, orderListId }, true); },
  };
}

// --- Redondeo según las reglas de cada par (Binance rechaza decimales de más) ---
const decimals = (step) => { const s = String(step); if (!s.includes('.')) return 0; return s.replace(/0+$/, '').split('.')[1]?.length || 0; };
export function floorToStep(value, step) {
  const d = decimals(step), st = +step;
  const v = Math.floor(value / st + 1e-9) * st;
  return v.toFixed(d);
}
export function roundToTick(value, tick) {
  const d = decimals(tick), t = +tick;
  return (Math.round(value / t) * t).toFixed(d);
}

// ---------------------------------------------------------------------------
// MODO PAPEL: dinero virtual con PRECIOS REALES de Binance (datos públicos).
// Simula compras, ventas y stops como lo haría Binance, para medir la estrategia
// sin arriesgar dinero. Un stop se considera ejecutado si el precio real (mínimo
// de cada hora) lo tocó, aunque el bot haya estado apagado en ese momento.
// ---------------------------------------------------------------------------
export function createPaperExchange({ fetchFn = globalThis.fetch, now = () => Date.now(), path = 'papel-estado.json', startUsdt = 50, slippagePct = 0.05, feePct = 0.1 }) {
  const DATA = 'https://data-api.binance.vision';
  const st = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { startUsdt, usdt: startUsdt, assets: {}, orders: {}, nextId: 1, createdAt: now() };
  const save = () => writeFileSync(path, JSON.stringify(st, null, 1));
  const filtersCache = {};
  const err = (code, msg) => Object.assign(new Error(`Binance (papel): ${msg}`), { code });
  async function get(p) {
    const res = await fetchFn(DATA + p);
    if (!res.ok) throw new Error(`Binance datos ${res.status}`);
    return res.json();
  }
  const baseOf = (symbol) => symbol.replace(/USDT$/, '');
  const price = async (symbol) => +(await get(`/api/v3/ticker/price?symbol=${symbol}`)).price;
  const fill = (qty, px, side) => {
    const p = px * (side === 'BUY' ? 1 + slippagePct / 100 : 1 - slippagePct / 100);
    return { p, quote: qty * p };
  };
  async function checkStop(o) {
    if (o.status !== 'NEW' || o.type !== 'STOP_LOSS') return;
    // Revisa los mínimos horarios desde la última revisión
    const k = await get(`/api/v3/klines?symbol=${o.symbol}&interval=1h&startTime=${o.lastCheck - 3600e3}&limit=1000`);
    let hit = null;
    for (const c of k) {
      if (c[6] < o.lastCheck - 3600e3) continue;
      if (+c[3] <= o.stopPrice) { hit = Math.min(o.stopPrice, +c[1]); break; }
    }
    if (hit == null) { const p = await price(o.symbol); if (p <= o.stopPrice) hit = p; }
    o.lastCheck = now();
    if (hit != null) {
      const f = fill(o.qty, hit, 'SELL');
      o.status = 'FILLED'; o.executedQty = String(o.qty); o.cummulativeQuoteQty = String(f.quote);
      st.usdt += f.quote * (1 - feePct / 100);
      st.assets[o.base].locked -= o.qty;
    }
    save();
  }
  return {
    mode: 'papel',
    async syncTime() { return 0; },
    async filters(symbol) {
      if (filtersCache[symbol]) return filtersCache[symbol];
      let out;
      try {
        const s = (await get(`/api/v3/exchangeInfo?symbol=${symbol}`)).symbols[0];
        const f = Object.fromEntries(s.filters.map((x) => [x.filterType, x]));
        out = { status: s.status, base: s.baseAsset, quote: s.quoteAsset, tickSize: f.PRICE_FILTER?.tickSize || '0.0001', stepSize: f.LOT_SIZE?.stepSize || '0.0001', minQty: +(f.LOT_SIZE?.minQty || 0), minNotional: +(f.NOTIONAL?.minNotional || f.MIN_NOTIONAL?.minNotional || 5), ocoAllowed: true, orderTypes: ['MARKET', 'STOP_LOSS'] };
      } catch {
        out = { status: 'TRADING', base: baseOf(symbol), quote: 'USDT', tickSize: '0.0001', stepSize: '0.0001', minQty: 0, minNotional: 5, ocoAllowed: true, orderTypes: ['MARKET', 'STOP_LOSS'] };
      }
      out.orderTypes = ['MARKET', 'STOP_LOSS'];
      filtersCache[symbol] = out;
      return out;
    },
    price,
    async balances() {
      const b = { USDT: { free: st.usdt, locked: 0 } };
      for (const [a, v] of Object.entries(st.assets)) b[a] = { free: Math.max(0, v.free), locked: v.locked };
      return b;
    },
    async marketBuy(symbol, quoteQty) {
      const q = +quoteQty;
      if (q > st.usdt + 1e-9) throw err(-2010, 'Account has insufficient balance for requested action.');
      const p = await price(symbol), f = fill(1, p, 'BUY');
      const qty = q / f.p, fee = qty * feePct / 100, base = baseOf(symbol);
      st.usdt -= q;
      (st.assets[base] ||= { free: 0, locked: 0 }).free += qty - fee;
      const id = st.nextId++; save();
      return { orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(q), fills: [{ commission: String(fee), commissionAsset: base }] };
    },
    async marketSell(symbol, quantity) {
      const base = baseOf(symbol), a = st.assets[base], qty = +quantity;
      if (!a || a.free + 1e-12 < qty) throw err(-2010, 'Account has insufficient balance for requested action.');
      const f = fill(qty, await price(symbol), 'SELL');
      a.free -= qty; st.usdt += f.quote * (1 - feePct / 100);
      const id = st.nextId++; save();
      return { orderId: id, executedQty: String(qty), cummulativeQuoteQty: String(f.quote) };
    },
    async stopSell(symbol, { quantity, stopPrice }) {
      const base = baseOf(symbol), a = st.assets[base], qty = +quantity, sp = +stopPrice;
      if (!a || a.free + 1e-12 < qty) throw err(-2010, 'Account has insufficient balance for requested action.');
      if (sp >= await price(symbol)) throw err(-2010, 'Stop price would trigger immediately.');
      a.free -= qty; a.locked += qty;
      const id = st.nextId++;
      st.orders[id] = { orderId: id, symbol, base, type: 'STOP_LOSS', status: 'NEW', stopPrice: sp, qty, executedQty: '0', cummulativeQuoteQty: '0', lastCheck: now() };
      save();
      return { orderId: id };
    },
    async cancelOrder(symbol, orderId) {
      const o = st.orders[orderId];
      if (o) await checkStop(o);
      if (!o || o.status !== 'NEW') throw err(-2011, 'Unknown order sent.');
      o.status = 'CANCELED'; st.assets[o.base].locked -= o.qty; st.assets[o.base].free += o.qty; save();
      return {};
    },
    async order(symbol, orderId) {
      const o = st.orders[orderId];
      if (!o) throw err(-2013, 'Order does not exist.');
      await checkStop(o);
      return { orderId: o.orderId, type: o.type, status: o.status, executedQty: o.executedQty, cummulativeQuoteQty: o.cummulativeQuoteQty };
    },
    paperSummary() { return { startUsdt: st.startUsdt, usdt: st.usdt, createdAt: st.createdAt }; },
  };
}
