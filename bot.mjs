// Bot de trading con confirmación: te propone operaciones por Telegram y SOLO
// opera si tocas "Sí". Pensado para correr 24/7 en un servidor (Oracle Cloud, Santiago).
//
// Arranque:  node --env-file=.env bot.mjs
// Variables (.env): BINANCE_MODE=testnet|real, BINANCE_API_KEY, BINANCE_API_SECRET,
//                   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createExchange, floorToStep, roundToTick } from './exchange.js';
import { runScan } from './scan.js';

export const DEFAULT_CONFIG = {
  orderUsdt: 7,            // monto por operación
  maxOrderUsdt: 10,        // tope duro: nunca se compra más que esto
  maxOpenTrades: 1,        // operaciones abiertas al mismo tiempo
  maxDailyLossUsdt: 0.5,   // si las pérdidas de hoy llegan a esto, el bot deja de proponer
  timeframes: ['1h', '4h'],
  minQuality: 'media',
  allowCaution: false,     // no proponer señales con PRECAUCIÓN
  target: 'tp1',           // 'tp1' (recomendado con poco capital) o 'tp2'
  entryTolerancePct: 0.6,  // si el precio ya subió más que esto sobre la entrada, se cancela
  proposalTtlMin: 20,      // los botones vencen a los 20 minutos
  stopLimitGapPct: 0.3,    // distancia entre el precio stop y el límite del stop
  maxHoldBars: 48,         // límite de tiempo: 48 velas de la temporalidad de la señal
  scanEveryMin: 15,
  monitorEverySec: 60,
  topN: 25,
  exclude: ['SOXLB'],
  feePct: 0.1,
};
const TF_MS = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 };
const qRank = { baja: 0, media: 1, alta: 2 };
const fmt = (x) => (x == null || isNaN(x) ? '–' : x >= 100 ? (+x).toFixed(2) : x >= 1 ? (+x).toFixed(4) : (+x).toPrecision(4));
const usd = (x) => `${x >= 0 ? '' : '-'}${Math.abs(x).toFixed(2)} USDT`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const today = (t) => new Date(t).toISOString().slice(0, 10);

export function createBot({ env, config = {}, statePath = 'bot-state.json', fetchFn = globalThis.fetch, now = () => Date.now(), scanFn = runScan, log = console.log }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const CHAT = String(env.TELEGRAM_CHAT_ID || '');
  const ex = createExchange({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, mode: env.BINANCE_MODE || 'testnet', fetchFn, now });
  const MODE = ex.mode === 'real' ? '💰 REAL' : '🧪 TESTNET';

  // ---------- Estado persistente ----------
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { paused: false, offset: 0, proposals: {}, trades: [], sent: {}, seq: 1 };
  const save = () => { writeFileSync(statePath + '.tmp', JSON.stringify(st, null, 1)); renameSync(statePath + '.tmp', statePath); };

  // ---------- Telegram ----------
  async function tg(method, body) {
    const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok && method !== 'getUpdates') log('Telegram error', method, j.description || res.status);
    return j;
  }
  const send = (text, buttons) => tg('sendMessage', {
    chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
  // Quita los botones del mensaje respondido y agrega la decisión al final
  const clearButtons = (msg, note) => msg && tg('editMessageText', {
    chat_id: CHAT, message_id: msg.message_id, disable_web_page_preview: true,
    text: (msg.text || '') + (note ? `\n\n${note}` : ''),
  });

  // ---------- Reglas de riesgo ----------
  const open = () => st.trades.filter((t) => t.status === 'abierta' || t.status === 'cerrando');
  const lossToday = () => st.trades.filter((t) => t.closedAt && today(t.closedAt) === today(now())).reduce((s, t) => s + (t.pnl || 0), 0);
  function blockedReason() {
    if (st.paused) return 'El bot está en pausa (/reanudar para activarlo).';
    if (open().length >= cfg.maxOpenTrades) return `Ya tienes ${open().length} operación abierta (máximo ${cfg.maxOpenTrades}).`;
    if (lossToday() <= -cfg.maxDailyLossUsdt) return `Llegaste a tu límite de pérdida diaria (${usd(lossToday())}). Mañana se reactiva.`;
    return null;
  }

  // ---------- 1. Buscar señales y proponer ----------
  async function scanAndPropose() {
    const scan = await scanFn({ topN: cfg.topN, timeframes: cfg.timeframes, exclude: cfg.exclude, minRR: 2 });
    const t = now();
    for (const [id, p] of Object.entries(st.proposals)) if (t - p.createdAt > 864e5) delete st.proposals[id];
    for (const k of Object.keys(st.sent)) if (t - st.sent[k] > 7 * 864e5) delete st.sent[k];

    // Señal de VENTA en una moneda que tienes abierta → preguntar si cerrar
    for (const tr of open()) {
      const s = scan.signals.find((x) => x.symbol === tr.symbol && x.action === 'VENTA' && TF_MS[x.timeframe] >= TF_MS[tr.timeframe]);
      const key = `venta|${tr.id}`;
      if (s && !st.sent[key]) {
        st.sent[key] = t;
        await send(`🔴 <b>Señal de VENTA en ${tr.symbol}</b> (${s.timeframe}), que tienes abierta.\n${esc(s.reasons[0] || '')}\n¿Cerrar la operación ahora a precio de mercado?`,
          [[{ text: '✅ Sí, cerrar', callback_data: `close:${tr.id}` }, { text: '❌ No, mantener', callback_data: `keep:${tr.id}` }]]);
      }
    }

    const reason = blockedReason();
    const candidates = scan.signals
      .filter((s) => s.action === 'COMPRA' && qRank[s.quality] >= qRank[cfg.minQuality] && (cfg.allowCaution || !s.caution))
      .filter((s) => !open().some((o) => o.symbol === s.symbol))
      .sort((a, b) => qRank[b.quality] - qRank[a.quality] || b.score - a.score);
    let proposed = 0;
    for (const s of candidates) {
      const key = `${s.symbol}|${s.timeframe}|${s.candleTime}`;
      if (st.sent[key]) continue;
      st.sent[key] = t;
      if (reason) { log('Señal omitida:', s.symbol, reason); continue; }
      if (proposed >= 1) break; // una propuesta por ciclo, para no saturarte
      const amount = Math.min(cfg.orderUsdt, cfg.maxOrderUsdt);
      const tp = cfg.target === 'tp2' ? s.tp2 : s.tp1;
      const slPct = (s.entry - s.sl) / s.entry, tpPct = (tp - s.entry) / s.entry;
      const id = String(st.seq++);
      st.proposals[id] = {
        id, symbol: s.symbol, timeframe: s.timeframe, entry: s.entry, sl: s.sl, tp, slPct, tpPct, amount,
        quality: s.quality, score: s.score, createdAt: t, status: 'pendiente',
      };
      const r = await send(
        `🟢 <b>COMPRA ${s.symbol}</b> · ${s.timeframe} · calidad ${s.quality.toUpperCase()} · ${MODE}\n` +
        `Entrada ${fmt(s.entry)} · SL ${fmt(s.sl)} (−${(slPct * 100).toFixed(2)}%) · TP ${fmt(tp)} (+${(tpPct * 100).toFixed(2)}%)\n` +
        `Monto: <b>${amount} USDT</b> → arriesgas ≈ ${usd(amount * slPct)} para ganar ≈ ${usd(amount * tpPct)}\n` +
        `• ${s.reasons.slice(0, 3).map(esc).join('\n• ')}\n` +
        `Si confirmas: compra a mercado + orden OCO automática (TP y Stop Loss).\n<i>Vence en ${cfg.proposalTtlMin} min. No es asesoría financiera.</i>`,
        [[{ text: `✅ Sí, comprar ${amount} USDT`, callback_data: `buy:${id}` }, { text: '❌ No', callback_data: `skip:${id}` }]]);
      st.proposals[id].messageId = r?.result?.message_id;
      proposed++;
    }
    save();
    return { signals: scan.signals.length, proposed };
  }

  // ---------- 2. Ejecutar una compra confirmada ----------
  async function executeBuy(p) {
    const t = now();
    if (t - p.createdAt > cfg.proposalTtlMin * 60e3) return { ok: false, msg: '⌛ La propuesta venció: el precio pudo haber cambiado. Espera la próxima señal.' };
    const reason = blockedReason();
    if (reason) return { ok: false, msg: '⛔ ' + reason };

    // ¿El precio real sigue siendo válido?
    const realPrice = await marketPrice(p.symbol);
    if (realPrice <= p.sl) return { ok: false, msg: `❌ Cancelado: el precio (${fmt(realPrice)}) ya cayó al Stop Loss.` };
    if (realPrice > p.entry * (1 + cfg.entryTolerancePct / 100)) return { ok: false, msg: `❌ Cancelado: el precio ya subió a ${fmt(realPrice)} (más de ${cfg.entryTolerancePct}% sobre la entrada). Comprar tarde empeora el riesgo/beneficio.` };

    const f = await ex.filters(p.symbol);
    if (f.status !== 'TRADING') return { ok: false, msg: `❌ ${p.symbol} no se puede operar ahora en Binance (${f.status}).` };
    const amount = Math.min(p.amount, cfg.maxOrderUsdt);
    // El lado del Stop Loss también debe superar el mínimo de Binance
    if (amount * (1 - p.slPct) < f.minNotional * 1.05) return { ok: false, msg: `❌ El monto (${amount} USDT) es muy chico: con el Stop Loss quedaría bajo el mínimo de Binance (${f.minNotional} USDT). Sube "orderUsdt".` };
    const bal = await ex.balances();
    const usdt = bal[f.quote]?.free || 0;
    if (usdt < amount) return { ok: false, msg: `❌ Saldo insuficiente: tienes ${usdt.toFixed(2)} ${f.quote} y la orden necesita ${amount}.` };

    // Compra a mercado
    const buy = await ex.marketBuy(p.symbol, amount);
    const qty = +buy.executedQty, quote = +buy.cummulativeQuoteQty;
    const avg = quote / qty;
    const feeBase = (buy.fills || []).filter((x) => x.commissionAsset === f.base).reduce((s, x) => s + +x.commission, 0);
    const sellQty = floorToStep(qty - feeBase, f.stepSize);
    // Niveles en % sobre el precio real de compra (en testnet el precio es distinto al real)
    const takeProfit = roundToTick(avg * (1 + p.tpPct), f.tickSize);
    const stopPrice = roundToTick(avg * (1 - p.slPct), f.tickSize);
    const stopLimit = roundToTick(avg * (1 - p.slPct) * (1 - cfg.stopLimitGapPct / 100), f.tickSize);
    const trade = {
      id: p.id, symbol: p.symbol, base: f.base, timeframe: p.timeframe, status: 'abierta', openedAt: t,
      deadline: t + TF_MS[p.timeframe] * cfg.maxHoldBars, buyQuote: quote, qty: sellQty, avg,
      takeProfit: +takeProfit, stopPrice: +stopPrice, buyOrderId: buy.orderId, orderListId: null,
    };
    st.trades.push(trade); save();

    // Protección inmediata con OCO (2 intentos)
    for (let i = 0; i < 2 && !trade.orderListId; i++) {
      try {
        const oco = await ex.ocoSell(p.symbol, { quantity: sellQty, takeProfit, stopPrice, stopLimit });
        trade.orderListId = oco.orderListId;
      } catch (e) {
        trade.ocoError = e.message;
        if (i === 0) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    save();
    if (!trade.orderListId) {
      await send(`⚠️ <b>Compré ${p.symbol} pero NO pude poner el Stop Loss</b>\n${esc(trade.ocoError)}\nTu posición está SIN protección. ¿Vender ahora?`,
        [[{ text: '🔻 Vender ahora', callback_data: `close:${trade.id}` }]]);
      return { ok: true, msg: `Compra ejecutada (${sellQty} ${f.base} a ${fmt(avg)}), pero falló la orden OCO.` };
    }
    return {
      ok: true,
      msg: `✅ <b>Compra ejecutada</b> (${MODE})\n${sellQty} ${f.base} a ${fmt(avg)} = ${quote.toFixed(2)} USDT\n` +
        `🎯 TP ${takeProfit} · 🛑 SL ${stopPrice}\nLímite de tiempo: ${new Date(trade.deadline).toLocaleString('es-CL', { timeZone: 'America/Santiago' })}\nTe aviso cuando se cierre.`,
    };
  }

  async function marketPrice(symbol) {
    // Precio del mercado REAL (público), sirva el bot en testnet o real
    const res = await fetchFn(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) throw new Error('No pude leer el precio de ' + symbol);
    return +(await res.json()).price;
  }

  // ---------- 3. Cerrar una operación (por VENTA, por tiempo o a pedido) ----------
  async function closeTrade(tr, why) {
    tr.status = 'cerrando'; save();
    if (tr.orderListId) {
      try { await ex.cancelOrderList(tr.symbol, tr.orderListId); } catch (e) {
        // Si ya se había ejecutado el TP o SL, el monitor lo registrará
        if (!/Unknown order|does not exist/i.test(e.message)) throw e;
        tr.status = 'abierta'; save();
        return `La orden OCO de ${tr.symbol} ya se había ejecutado; revisa el próximo aviso.`;
      }
    }
    const f = await ex.filters(tr.symbol);
    const bal = await ex.balances();
    const qty = floorToStep(Math.min(bal[f.base]?.free || 0, tr.qty * 1.0001), f.stepSize);
    const sell = await ex.marketSell(tr.symbol, qty);
    finish(tr, +sell.cummulativeQuoteQty, why);
    return `🔻 <b>${tr.symbol} cerrada</b> (${why}). Resultado aprox.: <b>${usd(tr.pnl)}</b>`;
  }

  function finish(tr, sellQuote, why) {
    tr.status = 'cerrada'; tr.closedAt = now(); tr.exit = why;
    tr.pnl = sellQuote - tr.buyQuote - sellQuote * cfg.feePct / 100;
    save();
  }

  // ---------- 4. Vigilar operaciones abiertas ----------
  async function monitor() {
    for (const tr of st.trades.filter((x) => x.status === 'abierta' && x.orderListId)) {
      const list = await ex.orderList(tr.orderListId);
      if (list.listOrderStatus === 'ALL_DONE') {
        let filled = null;
        for (const o of list.orders) {
          const od = await ex.order(tr.symbol, o.orderId);
          if (od.status === 'FILLED' || (+od.executedQty > 0)) filled = od;
        }
        if (filled) {
          const isTP = filled.type === 'LIMIT_MAKER';
          finish(tr, +filled.cummulativeQuoteQty, isTP ? 'Take Profit' : 'Stop Loss');
          await send(`${isTP ? '🎯' : '🛑'} <b>${tr.symbol}: ${tr.exit}</b>\nResultado aprox.: <b>${usd(tr.pnl)}</b>\nHoy llevas: ${usd(lossToday())}`);
        } else {
          tr.status = 'cerrada'; tr.closedAt = now(); tr.exit = 'cancelada fuera del bot'; tr.pnl = 0; save();
          await send(`ℹ️ La orden OCO de ${tr.symbol} fue cancelada fuera del bot. Ya no la sigo.`);
        }
        continue;
      }
      const key = `tiempo|${tr.id}`;
      if (now() > tr.deadline && !st.sent[key]) {
        st.sent[key] = now(); save();
        await send(`⏰ <b>${tr.symbol}</b> llegó a su límite de tiempo (${cfg.maxHoldBars} velas de ${tr.timeframe}) sin tocar TP ni SL.\n¿Cerrar a precio de mercado?`,
          [[{ text: '✅ Sí, cerrar', callback_data: `close:${tr.id}` }, { text: '❌ Mantener', callback_data: `keep:${tr.id}` }]]);
      }
    }
  }

  // ---------- 5. Respuestas a botones y comandos ----------
  async function handleUpdate(u) {
    const from = u.callback_query?.message?.chat?.id ?? u.message?.chat?.id;
    if (String(from) !== CHAT) { log('Ignorado: chat no autorizado', from); return; } // solo tú puedes dar órdenes
    if (u.callback_query) {
      const q = u.callback_query;
      await tg('answerCallbackQuery', { callback_query_id: q.id });
      const [action, id] = String(q.data).split(':');
      if (action === 'buy' || action === 'skip') {
        const p = st.proposals[id];
        if (!p || p.status !== 'pendiente') { await send('Esa propuesta ya fue respondida.'); return; }
        if (action === 'skip') { p.status = 'rechazada'; save(); await clearButtons(q.message, '❌ Descartada'); return; }
        p.status = 'ejecutando'; save();
        await clearButtons(q.message, '⏳ Ejecutando…');
        let r;
        try { r = await executeBuy(p); } catch (e) { r = { ok: false, msg: '❌ Error de Binance: ' + esc(e.message) }; }
        p.status = r.ok ? 'ejecutada' : 'cancelada'; save();
        await send(r.msg);
        return;
      }
      if (action === 'close' || action === 'keep') {
        const tr = st.trades.find((x) => x.id === id);
        if (!tr || tr.status !== 'abierta') { await send('Esa operación ya no está abierta.'); return; }
        await clearButtons(q.message, action === 'close' ? '⏳ Cerrando…' : '👍 Se mantiene');
        if (action === 'keep') return;
        try { await send(await closeTrade(tr, 'cierre manual')); } catch (e) { tr.status = 'abierta'; save(); await send('❌ No pude cerrar: ' + esc(e.message)); }
      }
      return;
    }
    const text = (u.message?.text || '').trim().toLowerCase();
    if (text.startsWith('/pausa')) { st.paused = true; save(); await send('⏸️ Bot en pausa: no propondrá operaciones. Las abiertas siguen protegidas por su OCO.'); }
    else if (text.startsWith('/reanudar')) { st.paused = false; save(); await send('▶️ Bot activo.'); }
    else if (text.startsWith('/estado') || text.startsWith('/start')) await send(await statusText());
    else if (text.startsWith('/cerrar')) {
      const o = st.trades.filter((x) => x.status === 'abierta');
      if (!o.length) await send('No tienes operaciones abiertas.');
      for (const tr of o) await send(`¿Cerrar <b>${tr.symbol}</b> a mercado?`, [[{ text: '✅ Sí, cerrar', callback_data: `close:${tr.id}` }, { text: '❌ No', callback_data: `keep:${tr.id}` }]]);
    } else if (text.startsWith('/actualizar')) {
      // Descarga la última versión desde GitHub y reinicia (el servicio lo vuelve a levantar)
      const { execFileSync } = await import('node:child_process');
      let out;
      try { out = execFileSync('git', ['pull', '--ff-only'], { encoding: 'utf8', timeout: 60e3 }); } catch (e) { await send('❌ No pude actualizar: ' + esc(e.message)); return; }
      await send('🔄 ' + esc(out.trim()) + '\nReiniciando…');
      setTimeout(() => process.exit(0), 1000);
    } else if (text.startsWith('/escanear')) { const r = await scanAndPropose(); await send(`🔎 Escaneo listo: ${r.signals} análisis, ${r.proposed} propuesta(s).`); }
    else await send('Comandos: /estado · /pausa · /reanudar · /cerrar · /escanear · /actualizar');
  }

  async function statusText() {
    let bal = '';
    try { const b = await ex.balances(); bal = `Saldo USDT: ${(b.USDT?.free || 0).toFixed(2)} libre`; } catch (e) { bal = 'No pude leer el saldo: ' + esc(e.message); }
    const o = st.trades.filter((x) => x.status === 'abierta');
    const closed = st.trades.filter((x) => x.status === 'cerrada');
    const wins = closed.filter((x) => x.pnl > 0).length;
    return `🤖 <b>Bot ${st.paused ? 'EN PAUSA' : 'activo'}</b> · ${MODE}\n${bal}\n` +
      `Hoy: ${usd(lossToday())} (límite −${cfg.maxDailyLossUsdt} USDT)\n` +
      `Abiertas: ${o.map((x) => `${x.symbol} (TP ${x.takeProfit} / SL ${x.stopPrice})`).join(', ') || 'ninguna'}\n` +
      `Cerradas: ${closed.length} · ganadoras ${wins} · total ${usd(closed.reduce((s, x) => s + (x.pnl || 0), 0))}`;
  }

  async function poll() {
    const r = await tg('getUpdates', { offset: st.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    for (const u of r.result || []) {
      st.offset = u.update_id + 1; save();
      try { await handleUpdate(u); } catch (e) { log('Error al procesar', e); }
    }
  }

  return { cfg, state: st, scanAndPropose, monitor, handleUpdate, poll, executeBuy, closeTrade, exchange: ex, send, statusText };
}

// ---------- Ejecución continua ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  for (const k of ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    if (!env[k]) { console.error(`Falta ${k} en el archivo .env`); process.exit(1); }
  }
  const config = existsSync('bot-config.json') ? JSON.parse(readFileSync('bot-config.json', 'utf8')) : {};
  const bot = createBot({ env, config, log: (...a) => console.log(new Date().toISOString(), ...a) });
  const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(new Date().toISOString(), name, e.message); } };
  await bot.exchange.syncTime().catch((e) => console.error('Hora de Binance:', e.message));
  await bot.send(`🤖 Bot iniciado (${bot.exchange.mode === 'real' ? '💰 REAL' : '🧪 TESTNET'}). Escribe /estado para ver tu saldo.`);
  setInterval(safe('escaneo', bot.scanAndPropose), bot.cfg.scanEveryMin * 60e3);
  setInterval(safe('monitor', bot.monitor), bot.cfg.monitorEverySec * 1e3);
  setInterval(safe('hora', bot.exchange.syncTime), 3600e3);
  safe('escaneo', bot.scanAndPropose)();
  for (;;) {
    try { await bot.poll(); } catch (e) { console.error(new Date().toISOString(), 'telegram', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
