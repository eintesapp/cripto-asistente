// Cliente FIRMADO de Binance Spot para operar (solo se usa en el servidor del bot).
// Las claves vienen de variables de entorno; nunca se escriben en el código.
import { createHmac } from 'node:crypto';

export const BASES = {
  testnet: 'https://testnet.binance.vision', // dinero ficticio
  real: 'https://api.binance.com',
};

export function createExchange({ apiKey, apiSecret, mode = 'testnet', fetchFn = globalThis.fetch, now = () => Date.now() }) {
  mode = String(mode || 'testnet').trim().toLowerCase();
  apiKey = String(apiKey || '').trim(); apiSecret = String(apiSecret || '').trim();
  if (!BASES[mode]) throw new Error('BINANCE_MODE debe ser "testnet" o "real"');
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
