import { klines, klinesHistory, HIGHER_TF, TIMEFRAMES } from './binance.js';
import { analyzeSeries } from './signals.js';
import { runScan } from './scan.js';
import { backtest, STRATEGIES } from './backtest.js';
import { positionSize, dailyLossStatus } from './risk.js';
import { drawChart, drawEquity } from './chart.js';

// ---------- Almacenamiento local (seguro ante modo privado) ----------
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const DEFAULT_SETTINGS = {
  capital: 1000, riskPct: 1, minRR: 2, maxDailyLossPct: 3, maxExposurePct: 20, feePct: 0.1,
  topN: 25, liveTfs: ['15m', '1h', '4h'], autoRefreshMin: 5, notify: false, minQualityNotify: 'media', watch: '',
};
let settings = { ...DEFAULT_SETTINGS, ...store.get('settings', {}) };
const state = { scan: null, source: '', history: [], scanning: false, progress: '', filter: { action: 'accion', tf: 'todas', quality: 'todas' } };

// ---------- Utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x) => (x == null || isNaN(x) ? '–' : x >= 1000 ? x.toLocaleString('es-CL', { maximumFractionDigits: 2 }) : x >= 1 ? x.toFixed(4).replace(/0+$/, '').replace(/\.$/, '') : x.toPrecision(4));
const pct = (x, d = 2) => (x == null || isNaN(x) ? '–' : (x > 0 ? '+' : '') + x.toFixed(d) + '%');
const usd = (x) => (x == null ? '–' : x.toLocaleString('es-CL', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }));
const time = (t) => new Date(t).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : m < 1440 ? `hace ${Math.round(m / 60)} h` : `hace ${Math.round(m / 1440)} d`; };
const qRank = { baja: 0, media: 1, alta: 2 };
const binanceUrl = (s) => `https://www.binance.com/es/trade/${s.replace(/USDT$/, '_USDT')}?type=spot`;
const actionBadge = (s) => `<span class="badge b-${s.action}">${s.action}</span>${s.caution ? ' <span class="badge b-PRECAUCION">PRECAUCIÓN</span>' : ''}`;
const trendTxt = (t) => ({ alcista: '<span class="up">alcista ▲</span>', bajista: '<span class="down">bajista ▼</span>', lateral: '<span class="muted">lateral ▬</span>' }[t] || '<span class="muted">n/d</span>');
const setStatus = (t) => ($('#status').innerHTML = t);
const DISCLAIMER = '<p class="note">Herramienta de análisis técnico, no asesoría financiera. Las señales no garantizan ganancias: usa siempre Stop Loss y arriesga solo lo que puedes perder. La “puntuación técnica” cuenta indicadores a favor; no es una probabilidad de acierto.</p>';

// ---------- Datos ----------
async function loadScannerData() {
  try {
    const [s, h] = await Promise.all([
      fetch('data/signals.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      fetch('data/history.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])),
    ]);
    state.history = Array.isArray(h) ? h : [];
    if (s && s.generatedAt) { state.scan = s; state.source = 'escáner automático'; }
  } catch {}
}

async function liveScan() {
  if (state.scanning) return;
  state.scanning = true;
  const prevKeys = new Set((state.scan?.signals || []).filter(isActionable).map(sigKey));
  try {
    const watch = settings.watch.split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase()).map((s) => (s.endsWith('USDT') ? s : s + 'USDT'));
    const r = await runScan({
      topN: settings.topN, extraSymbols: watch, timeframes: settings.liveTfs, minRR: settings.minRR,
      onProgress: (d, t) => setStatus(`<span class="spin"></span> ${Math.round(d / t * 100)}%`),
    });
    delete r.data;
    state.scan = r; state.source = 'análisis en vivo';
    const fresh = r.signals.filter(isActionable).filter((s) => !prevKeys.has(sigKey(s)) && qRank[s.quality] >= qRank[settings.minQualityNotify]);
    notifyNew(fresh);
  } catch (e) {
    setStatus('');
    toast('No se pudo conectar con Binance: ' + e.message);
  } finally {
    state.scanning = false;
    updateStatus();
    render();
  }
}

const isActionable = (s) => s.action === 'COMPRA' || s.action === 'VENTA';
const sigKey = (s) => `${s.symbol}|${s.timeframe}|${s.action}`;
function updateStatus() { if (state.scan) setStatus(`${ago(state.scan.generatedAt)}`); }

async function notifyNew(list) {
  if (!settings.notify || !list.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const s of list.slice(0, 5)) {
    const title = `${s.action === 'COMPRA' ? '🟢' : '🔴'} ${s.action} ${s.symbol} (${s.timeframe})`;
    const body = `Calidad ${s.quality} · Entrada ${fmt(s.entry)} · SL ${fmt(s.sl)} · TP1 ${fmt(s.tp1)}`;
    const data = { url: `#/senal/${s.symbol}/${s.timeframe}` };
    if (reg) reg.showNotification(title, { body, data, icon: 'icon-192.png', tag: sigKey(s) });
    else new Notification(title, { body });
  }
}

function toast(msg) {
  const d = document.createElement('div');
  d.className = 'danger'; d.style.cssText = 'position:fixed;left:16px;right:16px;bottom:80px;z-index:9';
  d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 5000);
}

// ---------- Componentes ----------
function signalCard(s) {
  const act = isActionable(s);
  return `<div class="card sig ${s.action} ${s.caution ? 'caution' : ''}" data-go="#/senal/${s.symbol}/${s.timeframe}">
    <div class="row between"><div class="row"><b>${esc(s.symbol.replace(/USDT$/, ''))}</b><span class="muted small">/USDT · ${s.timeframe}</span></div>
      <div>${actionBadge(s)}</div></div>
    <div class="row between small" style="margin-top:4px"><span class="mono">${fmt(s.currentPrice ?? s.price)} <span class="${s.change24h >= 0 ? 'up' : 'down'}">${pct(s.change24h)}</span></span>
      <span><span class="badge q-${s.quality}">calidad ${s.quality}</span> <span class="muted">${s.score}/10</span></span></div>
    ${act ? `<div class="levels mono"><div>Entrada<b>${fmt(s.entry)}</b></div><div class="down">SL<b>${fmt(s.sl)}</b></div><div class="up">TP1<b>${fmt(s.tp1)}</b></div><div class="up">TP2<b>${fmt(s.tp2)}</b></div></div>
    <div class="small muted" style="margin-top:6px">R/B ${s.rr1.toFixed(1)} · ${s.rr2.toFixed(1)} · ${esc(s.reasons[0] || '')}</div>`
    : `<div class="small muted" style="margin-top:6px">${esc(s.reasons[0] || '')}</div>`}
  </div>`;
}

function marketCard(m) {
  if (!m) return '';
  const col = { alcista: 'var(--buy)', bajista: 'var(--sell)', mixto: 'var(--warn)' }[m.mood] || 'var(--wait)';
  const txt = { alcista: 'La mayoría de las monedas sube. Las compras tienen el viento a favor.', bajista: 'La mayoría de las monedas baja. Mayor riesgo para comprar: sé selectivo.', mixto: 'Mercado sin dirección clara. Exige más confirmación.' }[m.mood] || '';
  return `<div class="card"><div class="mood"><span class="dot" style="background:${col}"></span><div><b>Mercado ${esc(m.mood)}</b>
    <div class="small muted">${m.breadth != null ? m.breadth.toFixed(0) + '% de las principales monedas sobre su EMA 50 (4h)' : ''}</div></div></div>
    <div class="small" style="margin-top:6px">${txt}</div></div>
    <div class="grid2">${m.majors.map((x) => `<div class="card" data-go="#/senal/${x.symbol}/4h" style="cursor:pointer">
      <div class="muted small">${x.symbol.replace('USDT', '')}</div><div class="big mono">${fmt(x.price)}</div>
      <div class="small ${x.change24h >= 0 ? 'up' : 'down'}">${pct(x.change24h)} 24h</div>
      <div class="small">4h ${trendTxt(x.trend4h)} · 1d ${trendTxt(x.trend1d)}</div></div>`).join('')}</div>`;
}

// ---------- Vistas ----------
function vInicio() {
  const s = state.scan;
  if (!s) return `<div class="empty">${state.scanning ? '<span class="spin"></span> Analizando el mercado…' : 'Sin datos. Toca ↻ para analizar.'}</div>`;
  const act = s.signals.filter(isActionable).sort((a, b) => qRank[b.quality] - qRank[a.quality] || b.score - a.score);
  const buys = act.filter((x) => x.action === 'COMPRA'), sells = act.filter((x) => x.action === 'VENTA');
  const dl = dailyLossStatus(store.get('trades', []), settings.capital, settings.maxDailyLossPct);
  const traders = rankTraders().slice(0, 3);
  const hist = state.history.slice(0, 3);
  return `
    ${dl.blocked ? `<div class="danger"><b>Límite de pérdida diaria alcanzado</b> (${usd(dl.pnl)}). Hoy no se recomienda abrir nuevas operaciones.</div>` : ''}
    ${marketCard(s.market)}
    <h2>Mejores oportunidades</h2>
    ${act.slice(0, 3).map(signalCard).join('') || '<div class="card muted small">Ninguna señal cumple todos los filtros ahora. Esperar también es una decisión.</div>'}
    <div class="grid2">
      <a class="card" href="#/senales?a=COMPRA" style="text-decoration:none;color:inherit"><div class="muted small">Señales de compra</div><div class="big up">${buys.length}</div></a>
      <a class="card" href="#/senales?a=VENTA" style="text-decoration:none;color:inherit"><div class="muted small">Señales de venta</div><div class="big down">${sells.length}</div></a>
    </div>
    <h2>Alertas activas</h2>
    ${s.events.slice(0, 6).map((e) => `<div class="card small" data-go="#/senal/${e.symbol}/${e.timeframe === '24h' ? '1h' : e.timeframe}" style="cursor:pointer">
      <b>${e.type === 'caida' ? '🔻' : e.type === 'subida' ? '🔺' : e.type === 'volumen' ? '📊' : '🔄'} ${esc(e.symbol)}</b> <span class="muted">${e.timeframe}</span><br>${esc(e.text)}</div>`).join('') || '<div class="card muted small">Sin eventos destacados.</div>'}
    <h2>Ranking de traders</h2>
    ${traders.length ? traders.map((t, k) => `<div class="card row between small"><span>${k + 1}. <b>${esc(t.name)}</b></span><span>Puntaje <b>${t.score}</b>/100</span></div>`).join('') : '<a class="card small" href="#/traders" style="display:block">Agrega traders de Binance Copy Trading para compararlos →</a>'}
    <h2>Historial reciente</h2>
    ${hist.length ? hist.map(histRow).join('') : '<div class="card muted small">El historial se llena cuando el escáner automático envía alertas.</div>'}
    <p class="small muted">Fuente: ${esc(state.source)} · ${time(s.generatedAt)} · ${s.pairs.length} pares analizados</p>
    ${DISCLAIMER}`;
}

function vSenales(params) {
  const s = state.scan;
  if (!s) return '<div class="empty">Sin datos todavía.</div>';
  const f = state.filter;
  if (params.get('a')) f.action = params.get('a');
  let list = s.signals.slice();
  if (f.action === 'accion') list = list.filter(isActionable);
  else if (f.action !== 'todas') list = list.filter((x) => x.action === f.action);
  if (f.tf !== 'todas') list = list.filter((x) => x.timeframe === f.tf);
  if (f.quality !== 'todas') list = list.filter((x) => qRank[x.quality] >= qRank[f.quality]);
  list.sort((a, b) => (isActionable(b) - isActionable(a)) || qRank[b.quality] - qRank[a.quality] || b.score - a.score);
  const chip = (group, val, label) => `<button class="chip ${f[group] === val ? 'on' : ''}" data-f="${group}" data-v="${val}">${label}</button>`;
  const tfs = [...new Set(s.signals.map((x) => x.timeframe))];
  return `
    <div class="chips">${chip('action', 'accion', 'Compra y venta')}${chip('action', 'COMPRA', 'Compra')}${chip('action', 'VENTA', 'Venta')}${chip('action', 'todas', 'Todas')}</div>
    <div class="chips">${chip('tf', 'todas', 'Todas')}${tfs.map((t) => chip('tf', t, t)).join('')}</div>
    <div class="chips">${chip('quality', 'todas', 'Cualquier calidad')}${chip('quality', 'media', 'Media o alta')}${chip('quality', 'alta', 'Solo alta')}</div>
    ${list.map(signalCard).join('') || '<div class="empty">No hay señales con estos filtros.</div>'}
    <p class="small muted">Las señales de VENTA en spot significan: vender lo que tienes o no comprar. Abrir posiciones en corto requiere futuros (alto riesgo).</p>`;
}

async function vDetalle(symbol, tf) {
  view.innerHTML = `<div class="empty"><span class="spin"></span> Analizando ${esc(symbol)} ${tf}…</div>`;
  let c, htf;
  try {
    [c, htf] = await Promise.all([klines(symbol, tf, 300), HIGHER_TF[tf] !== tf ? klines(symbol, HIGHER_TF[tf], 300) : null]);
  } catch (e) { return `<div class="danger">No se pudo leer Binance: ${esc(e.message)}</div>`; }
  const { signal: s, ind } = analyzeSeries(c, { symbol, timeframe: tf, opts: { minRR: settings.minRR } }, htf || c);
  const act = isActionable(s);
  const dl = dailyLossStatus(store.get('trades', []), settings.capital, settings.maxDailyLossPct);
  const ps = act ? positionSize({ capital: settings.capital, riskPct: settings.riskPct, entry: s.entry, sl: s.sl, maxExposurePct: settings.maxExposurePct, feePct: settings.feePct }) : null;
  const tfChips = TIMEFRAMES.map((t) => `<a class="chip ${t === tf ? 'on' : ''}" href="#/senal/${symbol}/${t}" style="text-decoration:none">${t}</a>`).join('');
  const html = `
    <div class="row between"><div><div class="big">${esc(symbol.replace('USDT', ''))}<span class="muted small">/USDT</span></div>
      <div class="mono">${fmt(s.currentPrice)}</div></div><div style="text-align:right">${actionBadge(s)}<br><span class="badge q-${s.quality}" style="margin-top:4px">calidad ${s.quality}</span></div></div>
    <div class="chips" style="margin-top:10px">${tfChips}</div>
    <div class="card" style="padding:8px"><canvas class="chart" id="chart"></canvas>
      <div class="legend"><span><i style="background:#4c8dff"></i>EMA 21</span><span><i style="background:#b36bff"></i>EMA 50</span><span><i style="background:#ff9f43"></i>SMA 200</span><span><i style="background:var(--warn)"></i>RSI</span></div></div>
    ${dl.blocked && act ? `<div class="danger">Alcanzaste tu límite de pérdida diaria. La app recomienda no abrir operaciones hoy.</div>` : ''}
    ${s.warnings.map((w) => `<div class="warn">⚠️ ${esc(w)}</div>`).join('')}
    <div class="card"><table class="mono">
      <tr><td>1. Criptomoneda</td><td>${esc(symbol)}</td></tr>
      <tr><td>2. Acción</td><td>${actionBadge(s)}${s.wouldBe ? ` <span class="small muted">(sería ${s.wouldBe})</span>` : ''}</td></tr>
      <tr><td>3. Precio actual</td><td>${fmt(s.currentPrice)}</td></tr>
      <tr><td>4. Entrada sugerida</td><td>${act ? fmt(s.entry) : '–'}</td></tr>
      <tr><td>5. Stop Loss</td><td class="down">${act ? `${fmt(s.sl)} (${s.riskPct.toFixed(2)}%)` : '–'}</td></tr>
      <tr><td>6. Take Profit 1</td><td class="up">${act ? `${fmt(s.tp1)} (${pct((s.tp1 - s.entry) / s.entry * 100)})` : '–'}</td></tr>
      <tr><td>7. Take Profit 2</td><td class="up">${act ? `${fmt(s.tp2)} (${pct((s.tp2 - s.entry) / s.entry * 100)})` : '–'}</td></tr>
      <tr><td>8. Riesgo/beneficio</td><td>${act ? `1 : ${s.rr1.toFixed(1)} / 1 : ${s.rr2.toFixed(1)}` : '–'}</td></tr>
      <tr><td>9. Temporalidad</td><td>${tf} (confirmada con ${HIGHER_TF[tf]}: ${s.htfTrend})</td></tr>
      <tr><td>11. Puntuación técnica</td><td>${s.score}/10 · calidad ${s.quality}</td></tr>
      <tr><td>12. Generada</td><td>${time(s.generatedAt)} <span class="muted small">(vela cerrada ${time(s.candleTime)})</span></td></tr>
    </table></div>
    <h2>10. Justificación técnica</h2>
    <div class="card"><ul class="reasons">${s.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
      <div class="small muted" style="margin-top:8px">RSI ${s.rsi?.toFixed(0)} · ATR ${fmt(s.atr)} · Volumen ${s.volRatio?.toFixed(1)}× promedio · Tendencia ${s.trend} · Soporte ${fmt(s.support)} · Resistencia ${fmt(s.resistance)}</div></div>
    ${ps ? `<h2>Tamaño de posición sugerido</h2><div class="card">
      <div class="grid2 mono"><div><div class="muted small">${s.action === 'COMPRA' ? 'Comprar' : 'Vender (si tienes)'}</div><b>${ps.qty.toPrecision(5)} ${esc(symbol.replace('USDT', ''))}</b></div><div><div class="muted small">Monto</div><b>${usd(ps.notional)}</b></div>
      <div><div class="muted small">Pérdida si toca SL</div><b class="down">${usd(ps.riskAmount)}</b></div><div><div class="muted small">% del capital</div><b>${ps.riskPctReal.toFixed(2)}%</b></div></div>
      ${ps.capped ? `<div class="warn">Limitado por tu exposición máxima por moneda (${settings.maxExposurePct}%).</div>` : ''}
      ${ps.belowMin ? `<div class="warn">El monto es menor al mínimo de Binance (~5 USDT).</div>` : ''}
      <p class="note">Calculado con capital ${usd(settings.capital)}, riesgo ${settings.riskPct}% por operación y comisión ${settings.feePct}% por lado. Cámbialo en Más → Ajustes.</p></div>` : ''}
    ${s.events.length ? `<h2>Eventos</h2>${s.events.map((e) => `<div class="card small">${esc(e.text)}</div>`).join('')}` : ''}
    <a class="btn" href="${binanceUrl(symbol)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;background:var(--accent);color:#fff;padding:12px;border-radius:10px">Abrir ${esc(symbol)} en Binance (operar a mano)</a>
    ${DISCLAIMER}`;
  view.innerHTML = html;
  requestAnimationFrame(() => drawChart($('#chart'), c, ind, s));
  return null;
}

function histRow(h) {
  const col = { TP2: 'up', TP1: 'up', SL: 'down' }[h.status] || 'muted';
  return `<div class="card small sig ${h.action}" data-go="#/senal/${h.symbol}/${h.timeframe}"><div class="row between">
    <span><b>${esc(h.symbol)}</b> ${h.timeframe} <span class="badge b-${h.action}">${h.action}</span></span><span class="${col}"><b>${esc(h.status)}</b>${h.resultR != null ? ` (${h.resultR > 0 ? '+' : ''}${h.resultR.toFixed(1)}R)` : ''}</span></div>
    <div class="muted mono">${time(h.generatedAt)} · E ${fmt(h.entry)} · SL ${fmt(h.sl)} · TP1 ${fmt(h.tp1)} · ${h.quality}</div></div>`;
}

function vHistorial() {
  const h = state.history;
  const closed = h.filter((x) => ['TP1', 'TP2', 'SL'].includes(x.status));
  const wins = closed.filter((x) => x.status !== 'SL');
  const avgR = closed.length ? closed.reduce((a, x) => a + (x.resultR || 0), 0) / closed.length : 0;
  return `
    <div class="card"><b>Rendimiento real de las alertas</b>
      <div class="grid2 mono" style="margin-top:8px"><div><div class="muted small">Cerradas</div><b>${closed.length}</b> <span class="muted small">de ${h.length}</span></div>
      <div><div class="muted small">Llegaron a TP</div><b>${closed.length ? (wins.length / closed.length * 100).toFixed(0) + '%' : '–'}</b></div>
      <div><div class="muted small">Resultado medio</div><b class="${avgR >= 0 ? 'up' : 'down'}">${closed.length ? (avgR > 0 ? '+' : '') + avgR.toFixed(2) + 'R' : '–'}</b></div>
      <div><div class="muted small">Abiertas</div><b>${h.filter((x) => x.status === 'abierta').length}</b></div></div>
      <p class="note">R = múltiplos del riesgo. +1R significa ganar lo mismo que se arriesgaba. Supuesto: 50% se cierra en TP1 y el resto en TP2 o en el precio de entrada. ${closed.length < 30 ? '<b>Con menos de 30 señales cerradas estas cifras no son estadísticamente confiables.</b>' : ''}</p></div>
    ${h.map(histRow).join('') || '<div class="empty">Aún no hay historial. El escáner automático lo registra cada vez que envía una alerta.</div>'}`;
}

// ---------- Traders (ranking propio con datos ingresados por ti) ----------
function scoreTrader(t) {
  const r30 = +t.roi30 || 0, r90 = +t.roi90 || 0, r180 = t.roi180 === '' || t.roi180 == null ? null : +t.roi180, dd = Math.max(+t.mdd || 0, 1), days = +t.days || 0;
  const flags = [];
  const calmar = r90 / dd; // retorno 90d por cada 1% de máximo retroceso
  let s = Math.max(0, Math.min(calmar / 3, 1)) * 40;
  const positives = [r30, r90, r180].filter((x) => x != null && x > 0).length, total = [r30, r90, r180].filter((x) => x != null).length;
  let cons = positives / total;
  if (r90 > 0 && r30 > r90 * 0.8) { cons *= 0.6; flags.push('Casi toda la ganancia es reciente'); }
  s += cons * 25;
  s += Math.min(days / 365, 1) * 20;
  s += (1 - Math.min(dd / 50, 1)) * 15;
  if (r30 > 100 || r90 > 300) flags.push('Rentabilidad extraordinaria: probable alto apalancamiento');
  if (dd > 40) flags.push(`Retroceso máximo alto (${dd}%)`);
  if (days < 90) flags.push('Historial corto (< 90 días)');
  if (+t.copiers && +t.copiers < 20) flags.push('Pocos copiadores');
  // Penalizaciones: un resultado espectacular con mucho riesgo no debe quedar arriba
  if (r30 > 100 || r90 > 300) s -= 15;
  if (dd > 40) s -= 15;
  if (days < 90) s -= 10;
  return { ...t, score: Math.max(0, Math.round(s)), calmar, flags };
}
const rankTraders = () => store.get('traders', []).map(scoreTrader).sort((a, b) => b.score - a.score);

function vTraders() {
  const list = rankTraders();
  const favOnly = state.favOnly;
  const shown = favOnly ? list.filter((t) => t.fav) : list;
  return `
    <div class="warn"><b>Importante:</b> Binance no ofrece una API oficial pública para los rankings de Copy Trading, y la app no usa accesos no autorizados. Abre el perfil público del trader en Binance, copia sus cifras aquí y la app calcula un ranking propio ajustado por riesgo. Actualiza las cifras cada semana para seguir su evolución.</div>
    <a class="btn ghost" href="https://www.binance.com/es/copy-trading" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;padding:10px;border-radius:10px;margin-bottom:10px">Abrir Binance Copy Trading</a>
    <div class="chips"><button class="chip ${!favOnly ? 'on' : ''}" id="tAll">Todos</button><button class="chip ${favOnly ? 'on' : ''}" id="tFav">★ Favoritos</button></div>
    ${shown.map((t, k) => `<div class="card"><div class="row between"><div><b>${k + 1}. ${esc(t.name)}</b> ${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" class="small">perfil</a>` : ''}</div>
      <div class="row"><b class="big" style="font-size:18px">${t.score}</b><span class="muted small">/100</span><button class="star" data-fav="${esc(t.name)}">${t.fav ? '★' : '☆'}</button></div></div>
      <div class="levels mono"><div>ROI 30d<b>${pct(+t.roi30, 1)}</b></div><div>ROI 90d<b>${pct(+t.roi90, 1)}</b></div><div>ROI 180d<b>${t.roi180 !== '' ? pct(+t.roi180, 1) : '–'}</b></div><div>Máx. DD<b class="down">${t.mdd}%</b></div></div>
      <div class="small muted" style="margin-top:6px">${t.days} días operando · retorno/riesgo ${t.calmar.toFixed(1)} · ${t.copiers || '?'} copiadores · actualizado ${t.updated ? ago(t.updated) : '–'}
      ${t.prev ? ` · antes ROI 90d ${pct(+t.prev.roi90, 1)}` : ''}</div>
      ${t.flags.map((f) => `<div class="warn" style="margin:6px 0 0">⚠️ ${esc(f)}</div>`).join('')}
      <div class="row" style="margin-top:8px;gap:6px"><button class="btn ghost small" data-edit="${esc(t.name)}">Actualizar cifras</button><button class="btn ghost small" data-del="${esc(t.name)}">Eliminar</button></div></div>`).join('') || '<div class="empty">Aún no agregas traders.</div>'}
    <h2 id="tform">Agregar o actualizar trader</h2>
    <form class="card" id="traderForm">
      <label class="f">Nombre (como aparece en Binance)<input name="name" required></label>
      <label class="f">Enlace al perfil (opcional)<input name="url" type="url" placeholder="https://www.binance.com/..."></label>
      <div class="grid2"><label class="f">ROI 30 días %<input name="roi30" type="number" step="any" required></label><label class="f">ROI 90 días %<input name="roi90" type="number" step="any" required></label>
      <label class="f">ROI 180 días % (si existe)<input name="roi180" type="number" step="any"></label><label class="f">Máx. drawdown %<input name="mdd" type="number" step="any" required></label>
      <label class="f">Días operando<input name="days" type="number" required></label><label class="f">Copiadores<input name="copiers" type="number"></label></div>
      <button class="btn" type="submit">Guardar</button>
      <p class="note">Puntaje: 40% retorno ajustado por drawdown, 25% consistencia entre periodos, 20% trayectoria, 15% control del drawdown. Rentabilidades pasadas no garantizan resultados futuros.</p>
    </form>`;
}

// ---------- Más: backtesting, riesgo, ajustes ----------
function vMas() {
  return `
    <a class="card row between" href="#/backtest" style="text-decoration:none;color:inherit"><span><b>Backtesting</b><br><span class="small muted">Prueba las estrategias con datos históricos reales</span></span><span>›</span></a>
    <a class="card row between" href="#/riesgo" style="text-decoration:none;color:inherit"><span><b>Riesgo y pérdidas del día</b><br><span class="small muted">Registra resultados y controla tu exposición</span></span><span>›</span></a>
    <a class="card row between" href="#/ajustes" style="text-decoration:none;color:inherit"><span><b>Ajustes</b><br><span class="small muted">Capital, riesgo, alertas y monedas</span></span><span>›</span></a>
    ${DISCLAIMER}`;
}

function vBacktest() {
  const pairs = state.scan?.pairs?.map((p) => p.symbol) || ['BTCUSDT', 'ETHUSDT'];
  const last = store.get('bt', { symbol: 'BTCUSDT', tf: '1h', bars: 2000 });
  return `
    <form class="card" id="btForm">
      <label class="f">Par<input name="symbol" list="pairs" value="${esc(last.symbol)}"><datalist id="pairs">${pairs.map((p) => `<option value="${p}">`).join('')}</datalist></label>
      <div class="grid2"><label class="f">Temporalidad<select name="tf">${TIMEFRAMES.map((t) => `<option ${t === last.tf ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="f">Velas a probar<select name="bars">${[1000, 2000, 3000, 5000].map((b) => `<option ${b === last.bars ? 'selected' : ''}>${b}</option>`).join('')}</select></label></div>
      <button class="btn" type="submit" style="width:100%">Ejecutar backtest</button>
      <p class="note">Señal al cierre de la vela, entrada en la apertura de la siguiente, comisión ${settings.feePct}% por lado, riesgo ${settings.riskPct}% por operación, solo compras (spot). Si SL y TP se tocan en la misma vela se asume pérdida.</p>
    </form><div id="btOut"></div>`;
}

async function runBacktest(form) {
  const symbol = form.symbol.value.trim().toUpperCase(), tf = form.tf.value, bars = +form.bars.value;
  store.set('bt', { symbol, tf, bars });
  const out = $('#btOut');
  out.innerHTML = '<div class="empty"><span class="spin"></span> Descargando historial de Binance…</div>';
  try {
    const ms = { '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    const h = HIGHER_TF[tf];
    const c = await klinesHistory(symbol, tf, bars);
    const htfBars = Math.min(5000, Math.ceil(bars * ms[tf] / ms[h]) + 260);
    const htf = h !== tf ? await klinesHistory(symbol, h, htfBars) : c;
    out.innerHTML = '<div class="empty"><span class="spin"></span> Simulando…</div>';
    await new Promise((r) => setTimeout(r, 30));
    const common = { feePct: settings.feePct, riskPct: settings.riskPct, capital: settings.capital, opts: { minRR: settings.minRR } };
    const runs = [
      backtest(c, htf, { ...common, strategy: 'confluencia', minQuality: 'media' }),
      backtest(c, htf, { ...common, strategy: 'confluencia', minQuality: 'alta' }),
      backtest(c, htf, { ...common, strategy: 'cruce_ema' }),
      backtest(c, htf, { ...common, strategy: 'rsi_simple' }),
    ];
    const names = ['Confluencia (calidad media+)', 'Confluencia (solo alta)', STRATEGIES.cruce_ema, STRATEGIES.rsi_simple];
    const colors = ['#16c784', '#4c8dff', '#b36bff', '#ff9f43'];
    out.innerHTML = `<div class="card"><b>${esc(symbol)} ${tf}</b> <span class="small muted">${time(runs[0].from)} → ${time(runs[0].to)}</span>
      <div style="overflow-x:auto"><table class="mono" style="margin-top:8px"><tr><th>Estrategia</th><th>Ops</th><th>% gan.</th><th>Neto</th><th>Máx DD</th><th>PF</th></tr>
      ${runs.map((r, k) => `<tr><td><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${colors[k]}"></i> ${names[k]}</td><td>${r.trades}</td><td>${r.trades ? r.winRate.toFixed(0) + '%' : '–'}</td>
        <td class="${r.netPct >= 0 ? 'up' : 'down'}">${pct(r.netPct, 1)}</td><td class="down">${r.maxDDPct.toFixed(1)}%</td><td>${r.trades ? (isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : '∞') : '–'}</td></tr>`).join('')}
      <tr><td class="muted">Comprar y mantener</td><td></td><td></td><td class="${runs[0].buyHoldPct >= 0 ? 'up' : 'down'}">${pct(runs[0].buyHoldPct, 1)}</td><td></td><td></td></tr></table></div>
      <canvas class="eq" id="eq" style="margin-top:10px"></canvas>
      <p class="note">PF = factor de beneficio (ganancias ÷ pérdidas; mayor a 1,3 es razonable). Resultados con comisiones incluidas. ${runs[0].trades < 30 ? '<b>Menos de 30 operaciones: muestra pequeña, el resultado puede ser casualidad.</b>' : ''} Un buen resultado pasado no asegura el futuro: prueba varios pares y periodos antes de confiar en una estrategia.</p></div>`;
    requestAnimationFrame(() => drawEquity($('#eq'), runs.map((r, k) => ({ points: r.curve, color: colors[k] }))));
  } catch (e) { out.innerHTML = `<div class="danger">Error: ${esc(e.message)}</div>`; }
}

function vRiesgo() {
  const trades = store.get('trades', []), positions = store.get('positions', []);
  const dl = dailyLossStatus(trades, settings.capital, settings.maxDailyLossPct);
  const today = new Date().toISOString().slice(0, 10);
  const exposure = positions.reduce((s, p) => s + +p.amount, 0);
  return `
    <div class="card"><b>Pérdida/ganancia de hoy</b><div class="big mono ${dl.pnl >= 0 ? 'up' : 'down'}">${usd(dl.pnl)}</div>
      <div class="small muted">Límite diario: ${usd(dl.limit)} (${settings.maxDailyLossPct}% de ${usd(settings.capital)})</div>
      ${dl.blocked ? '<div class="danger">Límite alcanzado: detente por hoy. Las señales seguirán visibles, pero la app te avisará que no operes.</div>' : `<div class="small">Te quedan ${usd(dl.remaining)} de margen antes del límite.</div>`}</div>
    <form class="card" id="tradeForm"><b>Registrar operación cerrada</b>
      <div class="grid2" style="margin-top:8px"><label class="f">Moneda<input name="symbol" placeholder="BTC" required></label><label class="f">Resultado (USDT, negativo si perdiste)<input name="pnl" type="number" step="any" required></label></div>
      <button class="btn" type="submit">Agregar</button></form>
    ${trades.filter((t) => t.date === today).map((t, k) => `<div class="card small row between"><span>${esc(t.symbol)}</span><span class="mono ${t.pnl >= 0 ? 'up' : 'down'}">${usd(t.pnl)}</span></div>`).join('')}
    <h2>Exposición actual</h2>
    <div class="card"><div class="small muted">Total invertido: <b>${usd(exposure)}</b> (${(exposure / settings.capital * 100).toFixed(0)}% del capital)</div>
      ${positions.map((p, k) => { const pc = p.amount / settings.capital * 100; return `<div class="row between small" style="margin-top:6px"><span>${esc(p.symbol)}</span><span class="mono ${pc > settings.maxExposurePct ? 'down' : ''}">${usd(+p.amount)} · ${pc.toFixed(0)}% ${pc > settings.maxExposurePct ? '⚠️ supera tu máximo' : ''}</span><button class="btn ghost" data-delpos="${k}" style="padding:2px 8px">×</button></div>`; }).join('')}
    </div>
    <form class="card" id="posForm"><b>Agregar posición abierta</b>
      <div class="grid2" style="margin-top:8px"><label class="f">Moneda<input name="symbol" placeholder="ETH" required></label><label class="f">Monto invertido (USDT)<input name="amount" type="number" step="any" required></label></div>
      <button class="btn" type="submit">Agregar</button></form>`;
}

function vAjustes() {
  const s = settings;
  const tfChip = (t) => `<label class="chip ${s.liveTfs.includes(t) ? 'on' : ''}"><input type="checkbox" name="tf" value="${t}" ${s.liveTfs.includes(t) ? 'checked' : ''} hidden>${t}</label>`;
  const notifState = !('Notification' in window) ? 'no disponible en este navegador' : Notification.permission === 'granted' ? 'permitidas' : Notification.permission === 'denied' ? 'bloqueadas (cámbialo en ajustes del navegador)' : 'sin permiso todavía';
  return `
    <form class="card" id="setForm">
      <h2 style="margin-top:0">Capital y riesgo</h2>
      <div class="grid2">
        <label class="f">Capital de referencia (USDT)<input name="capital" type="number" step="any" value="${s.capital}"></label>
        <label class="f">Riesgo por operación (%)<input name="riskPct" type="number" step="0.1" value="${s.riskPct}"></label>
        <label class="f">Riesgo/beneficio mínimo<input name="minRR" type="number" step="0.1" value="${s.minRR}"></label>
        <label class="f">Pérdida diaria máxima (%)<input name="maxDailyLossPct" type="number" step="0.5" value="${s.maxDailyLossPct}"></label>
        <label class="f">Exposición máx. por moneda (%)<input name="maxExposurePct" type="number" step="1" value="${s.maxExposurePct}"></label>
        <label class="f">Comisión por lado (%)<input name="feePct" type="number" step="0.01" value="${s.feePct}"></label>
      </div>
      <p class="note">Recomendación general para principiantes: arriesgar 0,5–1% por operación y no más de 2–3% de pérdida en un día.</p>
      <h2>Análisis en vivo</h2>
      <label class="f">Cantidad de monedas (por volumen)<input name="topN" type="number" min="5" max="60" value="${s.topN}"></label>
      <div class="chips">${TIMEFRAMES.map(tfChip).join('')}</div>
      <label class="f">Monedas extra a vigilar (ej: PEPE, LINK)<input name="watch" value="${esc(s.watch)}"></label>
      <label class="f">Actualizar cada (minutos, mientras la app está abierta)<input name="autoRefreshMin" type="number" min="1" value="${s.autoRefreshMin}"></label>
      <h2>Notificaciones en el celular</h2>
      <label class="f">Calidad mínima para avisar<select name="minQualityNotify"><option ${s.minQualityNotify === 'media' ? 'selected' : ''}>media</option><option ${s.minQualityNotify === 'alta' ? 'selected' : ''}>alta</option></select></label>
      <label class="row small"><input type="checkbox" name="notify" ${s.notify ? 'checked' : ''} style="width:auto"> Avisarme de señales nuevas mientras la app está abierta (estado: ${notifState})</label>
      <p class="note">Para recibir alertas con la app cerrada, configura Telegram con el escáner automático (ver README, paso 4).</p>
      <button class="btn" type="submit" style="width:100%;margin-top:10px">Guardar ajustes</button>
    </form>
    <button class="btn ghost" id="resetAll" style="width:100%">Restablecer ajustes</button>`;
}

// ---------- Router ----------
async function render() {
  const [path, query] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query || '');
  const parts = path.split('/').filter(Boolean);
  const tab = parts[0] || 'inicio';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === ({ senal: 'senales', backtest: 'mas', riesgo: 'mas', ajustes: 'mas' }[tab] || tab)));
  const titles = { inicio: 'Cripto Señales', senales: 'Señales', historial: 'Historial', traders: 'Traders', mas: 'Más', backtest: 'Backtesting', riesgo: 'Riesgo', ajustes: 'Ajustes', senal: 'Análisis' };
  $('#title').textContent = titles[tab] || 'Cripto Señales';
  let html;
  switch (tab) {
    case 'senales': html = vSenales(params); break;
    case 'senal': html = await vDetalle(parts[1], parts[2] || '1h'); break;
    case 'historial': html = vHistorial(); break;
    case 'traders': html = vTraders(); break;
    case 'mas': html = vMas(); break;
    case 'backtest': html = vBacktest(); break;
    case 'riesgo': html = vRiesgo(); break;
    case 'ajustes': html = vAjustes(); break;
    default: html = vInicio();
  }
  if (html != null) view.innerHTML = html;
}

// Delegación de eventos
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button')) { location.hash = go.dataset.go; return; }
  const chip = e.target.closest('[data-f]');
  if (chip) { state.filter[chip.dataset.f] = chip.dataset.v; history.replaceState(null, '', '#/senales'); render(); return; }
  const fav = e.target.closest('[data-fav]');
  if (fav) { const t = store.get('traders', []); const x = t.find((y) => y.name === fav.dataset.fav); if (x) x.fav = !x.fav; store.set('traders', t); render(); return; }
  const del = e.target.closest('[data-del]');
  if (del && confirm('¿Eliminar este trader?')) { store.set('traders', store.get('traders', []).filter((y) => y.name !== del.dataset.del)); render(); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) { const t = store.get('traders', []).find((y) => y.name === ed.dataset.edit); const f = $('#traderForm'); for (const k of ['name', 'url', 'roi30', 'roi90', 'roi180', 'mdd', 'days', 'copiers']) f[k].value = t[k] ?? ''; $('#tform').scrollIntoView({ behavior: 'smooth' }); return; }
  if (e.target.id === 'tAll' || e.target.id === 'tFav') { state.favOnly = e.target.id === 'tFav'; render(); return; }
  const dp = e.target.closest('[data-delpos]');
  if (dp) { const p = store.get('positions', []); p.splice(+dp.dataset.delpos, 1); store.set('positions', p); render(); return; }
  if (e.target.id === 'resetAll' && confirm('¿Restablecer los ajustes?')) { settings = { ...DEFAULT_SETTINGS }; store.set('settings', settings); render(); }
  const tfl = e.target.closest('label.chip');
  if (tfl) setTimeout(() => tfl.classList.toggle('on', tfl.querySelector('input').checked));
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, fd = new FormData(f);
  if (f.id === 'btForm') return runBacktest(f);
  if (f.id === 'traderForm') {
    const t = store.get('traders', []);
    const rec = Object.fromEntries(fd.entries());
    rec.updated = Date.now();
    const i = t.findIndex((y) => y.name.toLowerCase() === rec.name.toLowerCase());
    if (i >= 0) { rec.fav = t[i].fav; rec.prev = { roi30: t[i].roi30, roi90: t[i].roi90, mdd: t[i].mdd, updated: t[i].updated }; t[i] = rec; } else t.push(rec);
    store.set('traders', t); render(); return;
  }
  if (f.id === 'tradeForm') {
    const t = store.get('trades', []);
    t.push({ symbol: fd.get('symbol').toUpperCase(), pnl: +fd.get('pnl'), date: new Date().toISOString().slice(0, 10) });
    store.set('trades', t.slice(-500)); render(); return;
  }
  if (f.id === 'posForm') {
    const p = store.get('positions', []); p.push({ symbol: fd.get('symbol').toUpperCase(), amount: +fd.get('amount') });
    store.set('positions', p); render(); return;
  }
  if (f.id === 'setForm') {
    const num = (k) => +fd.get(k);
    const wantNotify = !!fd.get('notify');
    settings = {
      ...settings, capital: num('capital'), riskPct: num('riskPct'), minRR: num('minRR'), maxDailyLossPct: num('maxDailyLossPct'),
      maxExposurePct: num('maxExposurePct'), feePct: num('feePct'), topN: Math.min(60, Math.max(5, num('topN'))),
      liveTfs: fd.getAll('tf').length ? fd.getAll('tf') : ['1h'], watch: fd.get('watch'), autoRefreshMin: Math.max(1, num('autoRefreshMin')),
      minQualityNotify: fd.get('minQualityNotify'), notify: wantNotify,
    };
    if (wantNotify && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    store.set('settings', settings); scheduleRefresh(); toastOk('Ajustes guardados'); render();
  }
});

function toastOk(msg) { const d = document.createElement('div'); d.className = 'card'; d.style.cssText = 'position:fixed;left:16px;right:16px;bottom:80px;z-index:9;text-align:center'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 2000); }

let timer;
function scheduleRefresh() {
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') liveScan(); }, settings.autoRefreshMin * 60000);
}
setInterval(updateStatus, 30000);
$('#refresh').addEventListener('click', () => (location.hash.startsWith('#/senal/') ? render() : liveScan()));
window.addEventListener('hashchange', render);

// ---------- Inicio ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
(async () => {
  await loadScannerData();
  updateStatus();
  render();
  const stale = !state.scan || Date.now() - state.scan.generatedAt > 30 * 60000;
  if (stale) liveScan();
  scheduleRefresh();
})();
