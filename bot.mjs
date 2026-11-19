// Bot de trading con confirmación (v2): estrategia "Ruptura de 55 velas con stop que sube", en DIARIO.
// - Una vez al día, después del cierre de la vela diaria (00:00 UTC = 21:00 en Chile), revisa 20 criptos principales.
// - Si hay una ruptura, te propone la compra por Telegram y SOLO compra si tocas "Sí".
// - Pone el Stop Loss en Binance y cada día lo SUBE si el precio subió (nunca lo baja).
// - Sin objetivo fijo: la operación termina cuando el precio toca el stop.
//
// Arranque:  node --env-file=.env bot.mjs
// Variables (.env): BINANCE_MODE=testnet|real, BINANCE_API_KEY, BINANCE_API_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createExchange, floorToStep, roundToTick } from './exchange.js';
import { klines as fetchKlines, pool } from './binance.js';
import { MAJORS, TREND, breakoutSignal, trailingStop, trendIndicators } from './tendencia.js';

export const DEFAULT_CONFIG = {
  riskPct: 1.5,             // % del capital que se arriesga por operación (se ajusta al mínimo de Binance)
  minOrderUsdt: 6,          // mínimo por orden (Binance exige ~5 USDT)
  maxOrderUsdt: 15,         // tope duro por operación
  maxOpenTrades: 3,         // operaciones abiertas al mismo tiempo
  maxDailyLossUsdt: 2,      // si las pérdidas cerradas hoy llegan a esto, no propone más hasta mañana
  symbols: MAJORS,
  exclude: [],
  entryTolerancePct: 2,     // si el precio ya subió más que esto sobre el cierre de la señal, se cancela
  proposalTtlHours: 6,      // los botones vencen a las 6 horas
  minStopRaisePct: 0.3,     // solo mueve el stop si sube al menos esto (evita cambios mínimos)
  checkEveryMin: 10,        // cada cuánto revisa si cerró una vela diaria nueva
  monitorEverySec: 60,
  feePct: 0.1,
};
const fmt = (x) => (x == null || isNaN(x) ? '–' : x >= 100 ? (+x).toFixed(2) : x >= 1 ? (+x).toFixed(4) : (+x).toPrecision(4));
const usd = (x) => `${x < 0 ? '-' : ''}${Math.abs(x).toFixed(2)} USDT`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const day = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = 864e5;

export function createBot({ env, config = {}, statePath = 'bot-state.json', paperPath = 'papel-estado.json', fetchFn = globalThis.fetch, now = () => Date.now(), log = console.log, klinesFn = fetchKlines }) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const CHAT = String(env.TELEGRAM_CHAT_ID || '');
  const ex = createExchange({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET, mode: env.BINANCE_MODE || 'testnet', fetchFn, now, paperPath, paperStartUsdt: cfg.paperStartUsdt || 50 });
  const MODE = ex.mode === 'real' ? '💰 REAL' : ex.mode === 'papel' ? '📝 PAPEL (dinero virtual, precios reales)' : '🧪 TESTNET';
  const symbols = cfg.symbols.filter((s) => !cfg.exclude.map((e) => e.toUpperCase().replace(/USDT$/, '') + 'USDT').includes(s));

  // ---------- Estado ----------
  const st = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  Object.assign(st, { paused: st.paused ?? false, offset: st.offset ?? 0, proposals: st.proposals ?? {}, trades: st.trades ?? [], sent: st.sent ?? {}, seq: st.seq ?? 1, lastDailyCandle: st.lastDailyCandle ?? 0 });
  const save = () => { writeFileSync(statePath + '.tmp', JSON.stringify(st, null, 1)); renameSync(statePath + '.tmp', statePath); };

  // ---------- Telegram ----------
  async function tg(method, body) {
    const res = await fetchFn(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok && method !== 'getUpdates') log('Telegram error', method, j.description || res.status);
    return j;
  }
  const send = (text, buttons) => tg('sendMessage', { chat_id: CHAT, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) });
  const clearButtons = (msg, note) => msg && tg('editMessageText', { chat_id: CHAT, message_id: msg.message_id, disable_web_page_preview: true, text: (msg.text || '') + (note ? `\n\n${note}` : '') });

  // ---------- Precios reales (públicos) ----------
  async function realPrice(symbol) {
    const res = await fetchFn(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}`);
    if (!res.ok) throw new Error('No pude leer el precio de ' + symbol);
    return +(await res.json()).price;
  }

  // ---------- Riesgo ----------
  const openTrades = () => st.trades.filter((t) => t.status === 'abierta' || t.status === 'cerrando');
  const pnlToday = () => st.trades.filter((t) => t.closedAt && day(t.closedAt) === day(now())).reduce((s, t) => s + (t.pnl || 0), 0);
  function blockedReason() {
    if (st.paused) return 'El bot está en pausa (/reanudar para activarlo).';
    if (openTrades().length >= cfg.maxOpenTrades) return `Ya tienes ${openTrades().length} operaciones abiertas (máximo ${cfg.maxOpenTrades}).`;
    if (pnlToday() <= -cfg.maxDailyLossUsdt) return `Llegaste al límite de pérdida diaria (${usd(pnlToday())}).`;
    return null;
  }
  // Monto a comprar para arriesgar riskPct del capital, respetando mínimos y topes
  function sizing({ capital, freeUsdt, slPct, minNotional }) {
    const minAmount = Math.max(cfg.minOrderUsdt, (minNotional * 1.15) / (1 - slPct));
    let amount = (capital * cfg.riskPct / 100) / slPct;
    const raisedToMin = amount < minAmount;
    amount = Math.max(amount, minAmount);
    amount = Math.min(amount, cfg.maxOrderUsdt, freeUsdt * 0.98);
    if (amount < minAmount) return { ok: false, amount, minAmount };
    amount = Math.floor(amount * 100) / 100;
    const risk = amount * slPct + amount * cfg.feePct / 50;
    return { ok: true, amount, risk, riskPctOfCapital: risk / capital * 100, raisedToMin };
  }
  async function capitalNow() {
    const b = await ex.balances();
    const free = b.USDT?.free || 0;
    return { free, capital: free + openTrades().reduce((s, t) => s + t.buyQuote, 0) };
  }

  // ---------- Ciclo diario: subir stops y buscar rupturas ----------
  async function latestDailyClose() {
    const c = await klinesFn('BTCUSDT', '1d', 3);
    return c.closeTime[c.closeTime.length - 1];
  }
  async function dailyCycle({ force = false } = {}) {
    const last = await latestDailyClose();
    if (!force && last <= st.lastDailyCandle) return { skipped: true };
    const candles = {};
    const need = [...new Set([...symbols, ...openTrades().map((t) => t.symbol)])];
    await pool(need, async (s) => { candles[s] = await klinesFn(s, '1d', 300); }, 4);

    // 1) Subir el stop de las operaciones abiertas
    for (const tr of openTrades().filter((t) => t.status === 'abierta' && t.strategy === 'ruptura55')) {
      const c = candles[tr.symbol];
      if (!c || c.error) continue;
      try { await raiseStop(tr, c); } catch (e) { log('stop', tr.symbol, e.message); await send(`⚠️ No pude actualizar el stop de ${tr.symbol}: ${esc(e.message)}`); }
    }
    // 2) Buscar rupturas nuevas
    let proposed = 0;
    const found = [];
    for (const s of symbols) {
      const c = candles[s];
      if (!c || c.error || c.close.length < 210) continue;
      const sig = breakoutSignal(c);
      if (sig) found.push({ symbol: s, ...sig });
    }
    const reason = blockedReason();
    const free = cfg.maxOpenTrades - openTrades().length;
    for (const sig of found) {
      const key = `${sig.symbol}|${sig.candleTime}`;
      if (st.sent[key] || openTrades().some((t) => t.symbol === sig.symbol)) continue;
      st.sent[key] = now();
      if (reason || proposed >= free) { log('Ruptura sin proponer:', sig.symbol, reason || 'sin cupo'); continue; }
      await propose(sig);
      proposed++;
    }
    st.lastDailyCandle = Math.max(st.lastDailyCandle, last);
    for (const k of Object.keys(st.sent)) if (now() - st.sent[k] > 30 * DAY) delete st.sent[k];
    save();
    if (cfg.dailySummary !== false) {
      try { await send(dailySummary(candles, found.length, proposed)); } catch (e) { log('resumen', e.message); }
    }
    return { found: found.length, proposed };
  }

  /** Resumen nocturno: cuántas criptos revisó y cuáles están más cerca de dar señal. */
  function dailySummary(candles, found, proposed) {
    const rows = [];
    for (const s of symbols) {
      const c = candles[s];
      if (!c || c.error || c.close.length < 210) continue;
      const x = trendIndicators(c), i = c.close.length - 1;
      if (x.sma200[i] == null || x.prevHigh[i] == null) continue;
      const close = c.close[i];
      // Subida necesaria para cumplir las dos condiciones: superar el máximo de 55 días y la media de 200
      const falta = Math.max(0, (x.prevHigh[i] / close - 1) * 100, (x.sma200[i] / close - 1) * 100);
      rows.push({ s: s.replace(/USDT$/, ''), vsSma: (close / x.sma200[i] - 1) * 100, falta });
    }
    const sobre = rows.filter((r) => r.vsSma > 0);
    const cerca = [...rows].sort((a, b) => a.falta - b.falta).slice(0, 3);
    const pct = (v) => (v >= 0 ? '+' : '') + v.toFixed(1).replace('.', ',') + '%';
    const lineas = cerca.map((r) => `• ${r.s}: necesita subir ${pct(r.falta)}` + (r.vsSma > 0 ? ' (ya está sobre su media 200)' : ` (hoy ${pct(r.vsSma)} vs su media 200)`));
    const tono = sobre.length >= rows.length / 2 ? '🟢 mayoría alcista' : sobre.length === 0 ? '🔴 todo bajista' : '🟠 mayoría bajista';
    const abiertas = openTrades().length;
    return [
      `🌙 <b>Revisión diaria</b> · ${MODE.split(' (')[0]}`,
      `Revisé ${rows.length} criptos. Señales nuevas: <b>${found}</b>` + (found ? ` · propuestas: ${proposed}` : ''),
      `Sobre su media de 200 días: ${sobre.length} de ${rows.length} (${tono})`,
      `Operaciones abiertas: ${abiertas}`,
      '',
      '<b>Más cerca de dar señal:</b>',
      ...(lineas.length ? lineas : ['• sin datos']),
      '',
      ...(found ? [] : ['Sin señal hoy: el robot espera. Mañana vuelvo a revisar a las 21:00.']),
      '<i>Información, no recomendación de compra.</i>',
    ].join('\n');
  }

  async function propose(sig, { test = false } = {}) {
    let est = '';
    try {
      const { capital, free } = await capitalNow();
      const z = sizing({ capital, freeUsdt: free, slPct: sig.slPct, minNotional: 5 });
      est = z.ok ? `Monto ≈ <b>${z.amount.toFixed(2)} USDT</b> · arriesgas ≈ ${usd(z.risk)} (${z.riskPctOfCapital.toFixed(1)}% de tu capital)${z.raisedToMin ? ' — subido al mínimo de Binance' : ''}`
        : `⚠️ Saldo insuficiente para el mínimo (${z.minAmount.toFixed(2)} USDT)`;
    } catch (e) { est = 'No pude leer tu saldo: ' + esc(e.message); }
    const id = String(st.seq++);
    st.proposals[id] = { id, symbol: sig.symbol, close: sig.close, atr: sig.atr, slPct: sig.slPct, createdAt: now(), status: 'pendiente', test };
    const msg = await send(
      `${test ? '🧪 <b>PRUEBA</b> · ' : ''}📈 <b>RUPTURA ${sig.symbol}</b> · diario · ${MODE}\n` +
      `Cierre ${fmt(sig.close)} · Stop inicial ${fmt(sig.close - TREND.slAtr * sig.atr)} (−${(sig.slPct * 100).toFixed(1)}%)\n` +
      `${est}\n` +
      (sig.reasons ? `• ${sig.reasons.map(esc).join('\n• ')}\n` : '') +
      `Sin objetivo fijo: el stop <b>sube cada día</b> con el precio y la operación se cierra cuando lo toca.\n` +
      `<i>En las pruebas acertó ~35% de las veces: muchas pérdidas pequeñas y algunas ganancias grandes. Vence en ${cfg.proposalTtlHours} h. No es asesoría financiera.</i>`,
      [[{ text: '✅ Sí, comprar', callback_data: `buy:${id}` }, { text: '❌ No', callback_data: `skip:${id}` }]]);
    st.proposals[id].messageId = msg?.result?.message_id;
    save();
  }

  // ---------- Compra confirmada ----------
  async function executeBuy(p) {
    const t = now();
    if (t - p.createdAt > cfg.proposalTtlHours * 3600e3) return { ok: false, msg: '⌛ La propuesta venció. Espera la próxima señal.' };
    const reason = blockedReason();
    if (reason) return { ok: false, msg: '⛔ ' + reason };
    const ref = await realPrice(p.symbol);
    const stopReal = ref - TREND.slAtr * p.atr;
    if (ref > p.close * (1 + cfg.entryTolerancePct / 100)) return { ok: false, msg: `❌ Cancelado: el precio ya subió a ${fmt(ref)} (más de ${cfg.entryTolerancePct}% sobre el cierre de la señal).` };
    if (ref < p.close * (1 - 3 * p.slPct / 4)) return { ok: false, msg: `❌ Cancelado: el precio ya cayó a ${fmt(ref)}; la ruptura perdió fuerza.` };
    const slPct = (ref - stopReal) / ref;
    const f = await ex.filters(p.symbol);
    if (f.status !== 'TRADING') return { ok: false, msg: `❌ ${p.symbol} no se puede operar ahora (${f.status}).` };
    const { capital, free } = await capitalNow();
    const z = sizing({ capital, freeUsdt: free, slPct, minNotional: f.minNotional });
    if (!z.ok) return { ok: false, msg: `❌ Saldo insuficiente: tienes ${free.toFixed(2)} USDT libres y el mínimo para esta operación es ${z.minAmount.toFixed(2)} USDT.` };

    const buy = await ex.marketBuy(p.symbol, z.amount.toFixed(2));
    const qty = +buy.executedQty, quote = +buy.cummulativeQuoteQty, avg = quote / qty;
    const feeBase = (buy.fills || []).filter((x) => x.commissionAsset === f.base).reduce((s, x) => s + +x.commission, 0);
    const sellQty = floorToStep(qty - feeBase, f.stepSize);
    const k = avg / ref; // en testnet el precio es distinto al real: los niveles se trasladan en proporción
    const tr = {
      id: p.id, strategy: 'ruptura55', symbol: p.symbol, base: f.base, status: 'abierta', openedAt: t, test: !!p.test,
      sinceTime: Math.floor(t / DAY) * DAY, buyQuote: quote, qty: sellQty, avg, k, refEntry: ref,
      highestReal: ref, stopReal, stopPrice: null, stopOrderId: null,
    };
    st.trades.push(tr); save();
    try { await placeStop(tr, stopReal); }
    catch (e) {
      await send(`⚠️ <b>Compré ${p.symbol} pero NO pude poner el Stop Loss</b>\n${esc(e.message)}\nTu posición está SIN protección. ¿Vender ahora?`, [[{ text: '🔻 Vender ahora', callback_data: `close:${tr.id}` }]]);
      return { ok: true, msg: `Compra ejecutada (${sellQty} ${f.base} a ${fmt(avg)}), pero falló el stop.` };
    }
    return { ok: true, msg: `✅ <b>Compra ejecutada</b> (${MODE})\n${sellQty} ${f.base} a ${fmt(avg)} = ${quote.toFixed(2)} USDT\n🛑 Stop en Binance: ${tr.stopPrice} (−${((avg - tr.stopPrice) / avg * 100).toFixed(1)}%)\nCada día, después de las 21:00, subiré el stop si el precio subió. Te aviso cuando se cierre.` };
  }

  async function placeStop(tr, stopReal) {
    const f = await ex.filters(tr.symbol);
    const stopPrice = roundToTick(stopReal * tr.k, f.tickSize);
    if (+tr.qty * +stopPrice < f.minNotional) throw new Error(`la orden de stop quedaría bajo el mínimo de Binance (${f.minNotional} USDT)`);
    const market = !f.orderTypes.length || f.orderTypes.includes('STOP_LOSS');
    let o, lastErr;
    for (let i = 0; i < 2 && !o; i++) {
      try { o = await ex.stopSell(tr.symbol, { quantity: tr.qty, stopPrice, market, limitPrice: roundToTick(+stopPrice * 0.98, f.tickSize) }); }
      catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!o) throw lastErr;
    tr.stopOrderId = o.orderId; tr.stopPrice = +stopPrice; tr.stopReal = stopReal; save();
  }

  async function raiseStop(tr, c) {
    const t = trailingStop(c, tr.sinceTime, tr.highestReal);
    tr.highestReal = t.highest;
    if (t.stop == null || t.stop <= tr.stopReal * (1 + cfg.minStopRaisePct / 100)) { save(); return; }
    const ref = await realPrice(tr.symbol);
    if (ref <= t.stop) { // el precio ya está bajo el nuevo nivel: se cierra a mercado (igual que en la simulación)
      await send(await closeTrade(tr, 'el precio cayó bajo el stop que sube'));
      return;
    }
    const old = tr.stopOrderId;
    try { await ex.cancelOrder(tr.symbol, old); }
    catch (e) { if (!/Unknown order|does not exist/i.test(e.message)) throw e; await checkTrade(tr); if (tr.status !== 'abierta') return; }
    try { await placeStop(tr, t.stop); }
    catch (e) {
      await send(`⚠️ Quité el stop anterior de ${tr.symbol} pero no pude poner el nuevo: ${esc(e.message)}. ¿Vender ahora?`, [[{ text: '🔻 Vender ahora', callback_data: `close:${tr.id}` }]]);
      throw e;
    }
    const locked = (tr.stopPrice - tr.avg) / tr.avg * 100;
    await send(`🔼 <b>${tr.symbol}</b>: stop subido a ${tr.stopPrice} (${locked >= 0 ? 'asegura +' : ''}${locked.toFixed(1)}% sobre tu compra)`);
  }

  // ---------- Vigilar si el stop se ejecutó ----------
  async function checkTrade(tr) {
    if (!tr.stopOrderId || tr.status !== 'abierta') return;
    const o = await ex.order(tr.symbol, tr.stopOrderId);
    if (o.status === 'FILLED') {
      finish(tr, +o.cummulativeQuoteQty, 'Stop');
      const pct = tr.pnl / tr.buyQuote * 100;
      await send(`${tr.pnl >= 0 ? '🎯' : '🛑'} <b>${tr.symbol} cerrada por el stop</b>\nResultado aprox.: <b>${usd(tr.pnl)}</b> (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) · duró ${Math.max(1, Math.round((now() - tr.openedAt) / DAY))} días`);
    } else if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(o.status)) {
      tr.status = 'sin-stop'; save();
      await send(`⚠️ El stop de ${tr.symbol} fue cancelado fuera del bot. La posición quedó SIN protección.`, [[{ text: '🔻 Vender ahora', callback_data: `close:${tr.id}` }, { text: '🛡️ Poner stop de nuevo', callback_data: `restop:${tr.id}` }]]);
    }
  }
  async function monitor() { for (const tr of st.trades.filter((t) => t.status === 'abierta' && t.strategy === 'ruptura55')) await checkTrade(tr); }

  function finish(tr, sellQuote, why) {
    tr.status = 'cerrada'; tr.closedAt = now(); tr.exit = why;
    tr.pnl = sellQuote - tr.buyQuote - sellQuote * cfg.feePct / 100;
    save();
  }

  async function closeTrade(tr, why) {
    tr.status = 'cerrando'; save();
    if (tr.stopOrderId) {
      try { await ex.cancelOrder(tr.symbol, tr.stopOrderId); }
      catch (e) {
        if (!/Unknown order|does not exist/i.test(e.message)) { tr.status = 'abierta'; save(); throw e; }
        tr.status = 'abierta'; await checkTrade(tr);
        if (tr.status === 'cerrada') return `${tr.symbol} ya se había cerrado por el stop.`;
      }
    }
    const f = await ex.filters(tr.symbol);
    const bal = await ex.balances();
    const qty = floorToStep(Math.min(bal[f.base]?.free || 0, +tr.qty * 1.0001), f.stepSize);
    const sell = await ex.marketSell(tr.symbol, qty);
    finish(tr, +sell.cummulativeQuoteQty, why);
    return `🔻 <b>${tr.symbol} cerrada</b> (${why}). Resultado aprox.: <b>${usd(tr.pnl)}</b>`;
  }

  // ---------- Telegram: botones y comandos ----------
  async function handleUpdate(u) {
    const from = u.callback_query?.message?.chat?.id ?? u.message?.chat?.id;
    if (String(from) !== CHAT) { log('Ignorado: chat no autorizado', from); return; }
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
      const tr = st.trades.find((x) => x.id === id);
      if (action === 'restop' && tr) { try { tr.status = 'abierta'; await placeStop(tr, tr.stopReal); await send(`🛡️ Stop de ${tr.symbol} puesto de nuevo en ${tr.stopPrice}.`); } catch (e) { tr.status = 'sin-stop'; save(); await send('❌ ' + esc(e.message)); } return; }
      if (action === 'close' || action === 'keep') {
        if (!tr || !['abierta', 'sin-stop'].includes(tr.status)) { await send('Esa operación ya no está abierta.'); return; }
        await clearButtons(q.message, action === 'close' ? '⏳ Cerrando…' : '👍 Se mantiene');
        if (action === 'keep') return;
        try { if (tr.status === 'sin-stop') tr.stopOrderId = null; await send(await closeTrade(tr, 'cierre manual')); }
        catch (e) { tr.status = 'abierta'; save(); await send('❌ No pude cerrar: ' + esc(e.message)); }
      }
      return;
    }
    const text = (u.message?.text || '').trim().toLowerCase();
    if (text.startsWith('/pausa')) { st.paused = true; save(); await send('⏸️ Bot en pausa: no propondrá compras. Las operaciones abiertas siguen con su stop y el stop se seguirá subiendo.'); }
    else if (text.startsWith('/reanudar')) { st.paused = false; save(); await send('▶️ Bot activo.'); }
    else if (text.startsWith('/estado') || text.startsWith('/start')) await send(await statusText());
    else if (text.startsWith('/cerrar')) {
      const o = st.trades.filter((x) => ['abierta', 'sin-stop'].includes(x.status));
      if (!o.length) await send('No tienes operaciones abiertas.');
      for (const tr of o) await send(`¿Cerrar <b>${tr.symbol}</b> a mercado?`, [[{ text: '✅ Sí, cerrar', callback_data: `close:${tr.id}` }, { text: '❌ No', callback_data: `keep:${tr.id}` }]]);
    } else if (text.startsWith('/revisar') || text.startsWith('/escanear')) {
      const r = await dailyCycle({ force: true });
      await send(`🔎 Revisión diaria: ${r.found} ruptura(s) en ${symbols.length} criptos, ${r.proposed} propuesta(s) nueva(s). Stops revisados.`);
    } else if (text.startsWith('/prueba')) {
      if (ex.mode === 'real') { await send('⛔ /prueba solo funciona en modo TESTNET o PAPEL.'); return; }
      const symbol = ((text.split(/\s+/)[1] || 'BTC').toUpperCase().replace(/USDT$/, '')) + 'USDT';
      const c = await klinesFn(symbol, '1d', 300);
      const t = trailingStop(c, now());
      const close = await realPrice(symbol);
      await propose({ symbol, close, atr: t.atr, slPct: TREND.slAtr * t.atr / close, reasons: ['No es una señal real: sirve para probar compra → stop → subir stop → cierre'] }, { test: true });
    } else if (text.startsWith('/actualizar')) {
      const { execFileSync } = await import('node:child_process');
      try { const out = execFileSync('git', ['pull', '--ff-only'], { encoding: 'utf8', timeout: 60e3 }); await send('🔄 ' + esc(out.trim()) + '\nReiniciando…'); setTimeout(() => process.exit(0), 1000); }
      catch (e) { await send('❌ No pude actualizar: ' + esc(e.message)); }
    } else await send('Comandos: /estado · /revisar · /cerrar · /pausa · /reanudar' + (ex.mode !== 'real' ? ' · /prueba' : ''));
  }

  async function statusText() {
    let bal = '';
    try { const { free, capital } = await capitalNow(); bal = `USDT libres: ${free.toFixed(2)} · capital estimado: ${capital.toFixed(2)}`; } catch (e) { bal = 'No pude leer el saldo: ' + esc(e.message); }
    const o = st.trades.filter((x) => ['abierta', 'sin-stop'].includes(x.status));
    const lines = [];
    for (const tr of o) {
      let now$ = '';
      try { const p = await realPrice(tr.symbol); const pct = (p / tr.refEntry - 1) * 100; now$ = ` · ahora ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`; } catch {}
      lines.push(`• ${tr.symbol}: compra ${fmt(tr.avg)} · stop ${tr.status === 'sin-stop' ? '⚠️ SIN STOP' : tr.stopPrice}${now$}`);
    }
    const closed = st.trades.filter((x) => x.status === 'cerrada' && x.strategy === 'ruptura55' && !x.test);
    const wins = closed.filter((x) => x.pnl > 0).length;
    return `🤖 <b>Bot ${st.paused ? 'EN PAUSA' : 'activo'}</b> · ${MODE} · estrategia Ruptura 55 (diario)\n${bal}\n` +
      `Riesgo por operación: ${cfg.riskPct}% · máx. ${cfg.maxOpenTrades} abiertas · tope ${cfg.maxOrderUsdt} USDT por orden\n` +
      `Abiertas (${o.length}):\n${lines.join('\n') || '• ninguna'}\n` +
      `Cerradas: ${closed.length} · ganadoras ${wins} · total ${usd(closed.reduce((s, x) => s + (x.pnl || 0), 0))}\n` +
      (ex.paperSummary ? (() => { const ps = ex.paperSummary(); const cap = ps.usdt + o.reduce((s, t) => s + t.buyQuote, 0); return `📝 Papel: empezaste con ${ps.startUsdt} USDT el ${new Date(ps.createdAt).toLocaleDateString('es-CL')} · hoy ≈ ${cap.toFixed(2)} USDT (posiciones abiertas a precio de compra)\n`; })() : '') +
      `Última revisión diaria: ${st.lastDailyCandle ? new Date(st.lastDailyCandle + 1).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : 'aún no'}`;
  }

  async function poll() {
    const r = await tg('getUpdates', { offset: st.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    for (const u of r.result || []) {
      st.offset = u.update_id + 1; save();
      try { await handleUpdate(u); } catch (e) { log('Error al procesar', e); }
    }
  }

  return { cfg, state: st, dailyCycle, monitor, handleUpdate, poll, executeBuy, closeTrade, exchange: ex, send, statusText, sizing };
}

// ---------- Ejecución continua ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const modeEnv = String(env.BINANCE_MODE || 'testnet').trim().toLowerCase();
  const required = modeEnv === 'papel' ? ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] : ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const k of required) if (!env[k]) { console.error(`Falta ${k} en el archivo .env`); process.exit(1); }
  let config = {};
  if (existsSync('bot-config.json')) { try { const c = JSON.parse(readFileSync('bot-config.json', 'utf8')); config = c.v2 || {}; if (c.exclude) config.exclude = c.exclude; } catch (e) { console.error('bot-config.json inválido:', e.message); } }
  const mode = String(env.BINANCE_MODE || 'testnet').trim().toLowerCase();
  // Un archivo de estado por modo: las pruebas de Testnet nunca se mezclan con tus operaciones reales
  const bot = createBot({ env, config, statePath: `bot-state-${mode}.json`, log: (...a) => console.log(new Date().toISOString(), ...a) });
  const safe = (name, fn) => async () => { try { await fn(); } catch (e) { console.error(new Date().toISOString(), name, e.message); } };
  await bot.exchange.syncTime().catch((e) => console.error('Hora de Binance:', e.message));
  await bot.send(`🤖 Bot v2 iniciado (${bot.exchange.mode === 'real' ? '💰 REAL' : bot.exchange.mode === 'papel' ? '📝 PAPEL' : '🧪 TESTNET'}) · estrategia Ruptura 55 en diario.\nRevisa el mercado cada día después de las 21:00 (cierre diario). Escribe /estado.`);
  setInterval(safe('ciclo diario', bot.dailyCycle), bot.cfg.checkEveryMin * 60e3);
  setInterval(safe('monitor', bot.monitor), bot.cfg.monitorEverySec * 1e3);
  setInterval(safe('hora', bot.exchange.syncTime), 3600e3);
  safe('monitor', bot.monitor)();
  safe('ciclo diario', bot.dailyCycle)();
  for (;;) {
    try { await bot.poll(); } catch (e) { console.error(new Date().toISOString(), 'telegram', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
