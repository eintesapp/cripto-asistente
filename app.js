import { klines, klinesHistory, tickers24h, pool } from './binance.js';
import { MAJORS, TREND, trendIndicators, breakoutSignal, simulateTrend, simulatePortfolio } from './tendencia.js';
import { robotSvg } from './robot.js';
import { drawTrendChart, drawEquity, gaugeSvg } from './chart.js';

// ---------------- Preferencias (guardadas solo en este teléfono) ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let prefs = { capital: 50, riskPct: 1.5, botUser: '', ...store.get('prefs2', {}) };

// ---------------- Utilidades ----------------
const $ = (s) => document.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (x) => (x == null || isNaN(x) ? '–' : x >= 1000 ? x.toLocaleString('es-CL', { maximumFractionDigits: 0 }) : x >= 100 ? x.toLocaleString('es-CL', { maximumFractionDigits: 2 }) : x >= 1 ? x.toLocaleString('es-CL', { maximumFractionDigits: 4 }) : x.toPrecision(4));
const pct = (x, d = 1) => (x == null || isNaN(x) ? '–' : `${x > 0 ? '+' : ''}${x.toFixed(d)}%`);
const date = (t) => new Date(t).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: '2-digit' });
const ago = (t) => { const m = Math.round((Date.now() - t) / 6e4); return m < 1 ? 'ahora' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`; };
const name = (s) => s.replace(/USDT$/, '');
const COLORS = ['#f7931a', '#627eea', '#f3ba2f', '#14f195', '#23292f', '#c2a633', '#0033ad', '#ef0027', '#2a5ada', '#e84142', '#e6007a', '#345d9d', '#0ac18e', '#00c08b', '#ff007a', '#2e3148', '#14b6e7', '#3ab83a', '#06d6a0', '#4da2ff'];
const coinBadge = (s) => `<div class="coin" style="background:${COLORS[MAJORS.indexOf(s) % COLORS.length] || '#475569'}">${esc(name(s).slice(0, 4))}</div>`;
const binanceUrl = (s) => `https://www.binance.com/es/trade/${name(s)}_USDT?type=spot`;
const FULL = { BTCUSDT: 'Bitcoin', ETHUSDT: 'Ethereum', BNBUSDT: 'BNB', SOLUSDT: 'Solana', XRPUSDT: 'Ripple', DOGEUSDT: 'Dogecoin', ADAUSDT: 'Cardano', TRXUSDT: 'Tron', LINKUSDT: 'Chainlink', AVAXUSDT: 'Avalanche', DOTUSDT: 'Polkadot', LTCUSDT: 'Litecoin', BCHUSDT: 'Bitcoin Cash', NEARUSDT: 'Near', UNIUSDT: 'Uniswap', ATOMUSDT: 'Cosmos', XLMUSDT: 'Stellar', ETCUSDT: 'Ethereum Classic', APTUSDT: 'Aptos', SUIUSDT: 'Sui' };
const STATUS = {
  ruptura: { label: 'RUPTURA HOY', cls: 'p-ruptura' },
  cerca: { label: 'CERCA', cls: 'p-cerca' },
  tendencia: { label: 'EN TENDENCIA', cls: 'p-tendencia' },
  fuera: { label: 'BAJISTA', cls: 'p-fuera' },
};
const DISCLAIMER = '<p class="disclaimer">Eintes Robot es una herramienta de análisis, no asesoría financiera. Resultados pasados no garantizan resultados futuros. Usa siempre stop y solo dinero que puedas perder.</p>';
function toast(msg) { const d = document.createElement('div'); d.className = 'toast card'; d.textContent = msg; document.body.appendChild(d); setTimeout(() => d.remove(), 3500); }

// ---------------- Datos del mercado ----------------
const state = { market: null, loading: false, at: 0 };

async function loadMarket(force = false) {
  if (state.loading) return;
  if (!force && state.market && Date.now() - state.at < 5 * 60e3) return;
  state.loading = true; setStatus('<span class="spin"></span>');
  try {
    const [tick] = await Promise.all([tickers24h()]);
    const t = Object.fromEntries(tick.filter((x) => MAJORS.includes(x.symbol)).map((x) => [x.symbol, x]));
    const rows = [];
    await pool(MAJORS, async (s) => {
      const c = await klines(s, '1d', 300);
      if (!c || c.close.length < 210) return;
      rows.push(analyze(s, c, t[s]));
    }, 5);
    rows.sort((a, b) => MAJORS.indexOf(a.symbol) - MAJORS.indexOf(b.symbol));
    state.market = { rows, at: Date.now() };
    state.at = Date.now();
  } catch (e) {
    toast('No se pudo conectar con Binance: ' + e.message);
  } finally { state.loading = false; setStatus(state.at ? ago(state.at) : ''); }
}

function analyze(symbol, c, tk) {
  const x = trendIndicators(c);
  const i = c.close.length - 1;
  const price = tk ? +tk.lastPrice : c.lastPrice;
  const nextLevel = Math.max(...c.high.slice(-TREND.len)); // lo que el próximo cierre debe superar
  const inTrend = x.sma200[i] != null && c.close[i] > x.sma200[i];
  const sig = breakoutSignal(c);
  const dist = (nextLevel / price - 1) * 100;
  const status = sig ? 'ruptura' : inTrend && dist <= 3 ? 'cerca' : inTrend ? 'tendencia' : 'fuera';
  const atr = x.atr14[i];
  return { symbol, c, x, price, change: tk ? +tk.priceChangePercent : null, nextLevel, dist, inTrend, sig, status, atr, stopPct: TREND.slAtr * atr / price * 100, sma200: x.sma200[i] };
}

function sizing(stopPct) {
  const risk = prefs.capital * prefs.riskPct / 100;
  let amount = risk / (stopPct / 100);
  const min = Math.max(6, 5.75 / (1 - stopPct / 100));
  const raised = amount < min; amount = Math.max(amount, min);
  return { amount, risk: amount * stopPct / 100, riskPct: amount * stopPct / prefs.capital, raised, enough: amount <= prefs.capital };
}

// ---------------- Componentes ----------------
const setStatus = (h) => ($('#status').innerHTML = h);
function brand() {
  $('#brand').innerHTML = `${robotSvg(34, 'feliz', 'hb')}<div><b>EINTES ROBOT</b><small>Ruptura 55 · diario</small></div>`;
}
function nextReview() {
  const n = Date.now(), next = Math.ceil(n / 864e5) * 864e5; const m = Math.round((next - n) / 6e4);
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
function rowItem(r) {
  const st = STATUS[r.status];
  const sub = r.status === 'ruptura' ? `Rompió ${fmt(r.sig.breakoutLevel)} · stop −${r.stopPct.toFixed(1)}%`
    : r.status === 'fuera' ? `Bajo su media de 200 (${pct((r.price / r.sma200 - 1) * 100)})`
    : r.dist <= 0 ? `Ya supera ${fmt(r.nextLevel)}: falta confirmar al cierre (21:00)`
    : `Le falta ${r.dist.toFixed(1)}% para romper ${fmt(r.nextLevel)}`;
  return `<div class="item" data-go="#/moneda/${r.symbol}" data-name="${name(r.symbol).toLowerCase()} ${(FULL[r.symbol] || '').toLowerCase()}">${coinBadge(r.symbol)}
    <div class="grow"><div class="row between"><b>${name(r.symbol)}</b><span class="mono">${fmt(r.price)}</span></div>
    <div class="row between small"><span class="muted">${sub}</span><span class="${r.change >= 0 ? 'up' : 'down'} mono">${pct(r.change)}</span></div></div>
    <span class="pill ${st.cls}">${st.label}</span></div>`;
}

// ---------------- Vistas ----------------
function vInicio() {
  const m = state.market;
  if (!m) return loadingView('Estoy revisando las 20 criptos principales…');
  const rows = m.rows, br = rows.filter((r) => r.status === 'ruptura'), near = rows.filter((r) => r.status === 'cerca').sort((a, b) => a.dist - b.dist);
  const trendN = rows.filter((r) => r.inTrend).length, trendPct = trendN / rows.length * 100;
  const btc = rows.find((r) => r.symbol === 'BTCUSDT'), eth = rows.find((r) => r.symbol === 'ETHUSDT');
  let mood = 'feliz', title, text;
  if (br.length) { mood = 'alerta'; title = `¡Detecté ${br.length} ruptura${br.length > 1 ? 's' : ''} hoy!`; text = 'Si tu bot está encendido, ya te envió la propuesta a Telegram. Revisa el detalle antes de decidir.'; }
  else if (trendN <= 5) { mood = 'calma'; title = 'Mercado bajista: toca esperar'; text = `Solo ${trendN} de ${rows.length} criptos están en tendencia alcista. No comprar también protege tu dinero.`; }
  else if (near.length) { title = 'Sin rupturas hoy'; text = `${near.length} cripto${near.length > 1 ? 's están' : ' está'} a menos de 3% de romper. Las vigilo cada noche.`; }
  else { title = 'Todo tranquilo'; text = 'No hay rupturas ni criptos cerca de romper. Vuelvo a revisar después del cierre diario.'; }
  const regime = trendPct >= 60 ? ['Alcista', 'up'] : trendPct <= 30 ? ['Bajista', 'down'] : ['Mixto', ''];
  const tg = prefs.botUser ? `https://t.me/${prefs.botUser.replace(/^@/, '')}` : null;
  return `
    <section class="hero">${robotSvg(84, mood, 'hero')}<div class="bubble"><b>${esc(title)}</b><span>${esc(text)}</span></div></section>
    <div class="card"><div class="gauge">${gaugeSvg(trendPct)}<div><div class="small muted">Estado del mercado</div><div class="big ${regime[1]}">${regime[0]}</div>
      <div class="small muted">${trendN} de ${rows.length} criptos sobre su media de 200 días</div></div></div></div>
    <div class="grid2">${[btc, eth].filter(Boolean).map((r) => `<div class="card tap" data-go="#/moneda/${r.symbol}">
      <div class="row between"><span class="small muted">${name(r.symbol)}</span><span class="pill ${STATUS[r.status].cls}">${STATUS[r.status].label}</span></div>
      <div class="big mono" style="margin-top:6px">${fmt(r.price)}</div><div class="small ${r.change >= 0 ? 'up' : 'down'} mono">${pct(r.change)} 24h</div></div>`).join('')}</div>
    <h2>Rupturas de hoy <a href="#/mercado?f=ruptura">ver</a></h2>
    <div class="card list">${br.map(rowItem).join('') || '<div class="muted small">Ninguna por ahora. Las rupturas son pocas: entre 3 y 5 al mes entre las 20 criptos.</div>'}</div>
    <h2>Cerca de romper <a href="#/mercado?f=cerca">todas</a></h2>
    <div class="card list">${near.slice(0, 5).map(rowItem).join('') || '<div class="muted small">Ninguna cripto está a menos de 3% de su máximo de 55 días.</div>'}</div>
    <div class="card"><div class="row between"><div><div class="small muted">Próxima revisión del robot</div><div class="big">${nextReview()}</div><div class="tiny muted">Cierre diario: 21:00 en Chile</div></div>${robotSvg(54, 'calma', 'nr')}</div>
      ${tg ? `<a class="btn block" style="margin-top:12px" href="${tg}" target="_blank" rel="noopener">Abrir mi robot en Telegram</a>` : `<a class="btn ghost block" style="margin-top:12px" href="#/robot">Conectar mi bot de Telegram</a>`}</div>
    <p class="tiny muted" style="text-align:center">Datos públicos de Binance · actualizado ${ago(m.at)}</p>${DISCLAIMER}`;
}

function vMercado(params) {
  const m = state.market;
  if (!m) return loadingView('Cargando mercado…');
  const f = params.get('f') || 'todas';
  const order = { ruptura: 0, cerca: 1, tendencia: 2, fuera: 3 };
  let rows = m.rows.slice().sort((a, b) => order[a.status] - order[b.status] || a.dist - b.dist);
  if (f !== 'todas') rows = rows.filter((r) => r.status === f);
  const chip = (v, l) => `<a class="chip ${f === v ? 'on' : ''}" href="#/mercado?f=${v}" style="text-decoration:none">${l}</a>`;
  const cnt = (s) => m.rows.filter((r) => r.status === s).length;
  return `<div class="search"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input id="mSearch" type="search" placeholder="Buscar moneda (ej: sol, bitcoin)" autocomplete="off" value="${esc(state.q || '')}"></div>
    <div class="chips">${chip('todas', `Todas (${m.rows.length})`)}${chip('ruptura', `Rupturas (${cnt('ruptura')})`)}${chip('cerca', `Cerca (${cnt('cerca')})`)}${chip('tendencia', `En tendencia (${cnt('tendencia')})`)}${chip('fuera', `Bajistas (${cnt('fuera')})`)}</div>
    <div class="card list" id="mList">${rows.map(rowItem).join('') || '<div class="muted small">No hay criptos en esta categoría ahora.</div>'}<div class="muted small" id="mNone" style="display:none;padding:10px 0">No encontré esa moneda. El robot analiza solo las 20 criptos principales.</div></div>
    <div class="card small"><b>Cómo leerlo</b><div class="muted" style="margin-top:6px">
    <span class="pill p-ruptura">RUPTURA HOY</span> cerró sobre su máximo de 55 días en tendencia alcista: el robot propone comprar.<br><br>
    <span class="pill p-cerca">CERCA</span> en tendencia y a menos de 3% de romper.<br><br>
    <span class="pill p-tendencia">EN TENDENCIA</span> sobre su media de 200 días, todavía lejos del máximo.<br><br>
    <span class="pill p-fuera">BAJISTA</span> bajo su media de 200 días: el robot no compra.</div></div>`;
}

function vMoneda(symbol) {
  const m = state.market;
  if (!m) return loadingView('Cargando…');
  const r = m.rows.find((x) => x.symbol === symbol);
  if (!r) return '<div class="card">Moneda no disponible.</div>';
  const st = STATUS[r.status], z = sizing(r.stopPct);
  const stop = r.price * (1 - r.stopPct / 100);
  const sim = simulateTrend(r.c);
  const breaks = new Set(sim.trades.map((t) => r.c.time.indexOf(t.entryTime) - 1).filter((i) => i >= 0));
  if (sim.open) breaks.add(r.c.time.indexOf(sim.open.entryTime) - 1);
  r.x.breakIdx = breaks;
  const exp = r.status === 'ruptura' ? `Hoy ${name(symbol)} cerró en ${fmt(r.sig.close)}, por encima de su máximo de 55 días (${fmt(r.sig.breakoutLevel)}), y está sobre su media de 200. Es la señal que busca la estrategia.`
    : r.status === 'fuera' ? `${name(symbol)} está bajo su media de 200 días: tendencia de fondo bajista. El robot no compra aunque haya rebotes.`
    : r.dist <= 0 ? `${name(symbol)} ya está sobre su máximo de 55 días (${fmt(r.nextLevel)}). Para que sea señal tiene que CERRAR el día por encima (21:00 en Chile).`
    : `Para dar señal, ${name(symbol)} debe cerrar el día sobre ${fmt(r.nextLevel)} (le falta ${r.dist.toFixed(1)}%), manteniéndose sobre su media de 200.`;
  setTimeout(() => {
    const cv = $('#chart');
    if (cv) drawTrendChart(cv, r.c, r.x, [r.status === 'ruptura' ? { price: r.sig.breakoutLevel, label: 'Roto ✓', color: '#16a34a' } : { price: r.nextLevel, label: 'Romper', color: '#0ea5b7' }, ...(r.inTrend ? [{ price: stop, label: 'Stop', color: '#ef4444' }] : [])]);
  });
  return `<div class="row between" style="margin-bottom:12px"><div class="row">${coinBadge(symbol)}<div><div class="big">${name(symbol)}<span class="muted small"> /USDT</span></div>
    <div class="mono">${fmt(r.price)} <span class="${r.change >= 0 ? 'up' : 'down'} small">${pct(r.change)}</span></div></div></div><span class="pill ${st.cls}">${st.label}</span></div>
    <div class="card" style="padding:10px"><canvas class="chart" id="chart"></canvas>
      <div class="legend"><span><i style="background:#22d3ee"></i>Máximo 55 días</span><span><i style="background:#f59e0b"></i>Media 200</span><span><i style="background:#22c55e"></i>▲ Rupturas pasadas</span></div></div>
    <div class="callout info">${esc(exp)}</div>
    <div class="grid2">
      <div class="stat"><div class="k">${r.status === 'ruptura' ? 'Nivel que rompió' : 'Nivel a superar'}</div><div class="v mono">${fmt(r.status === 'ruptura' ? r.sig.breakoutLevel : r.nextLevel)}</div></div>
      <div class="stat"><div class="k">Distancia</div><div class="v mono">${r.status === 'ruptura' ? 'Rompió ✓' : r.dist <= 0 ? 'Encima ✓' : pct(r.dist)}</div></div>
      <div class="stat"><div class="k">Media 200 días</div><div class="v mono">${fmt(r.sma200)}</div></div>
      <div class="stat"><div class="k">Stop inicial si entra hoy</div><div class="v mono down">−${r.stopPct.toFixed(1)}%</div></div>
    </div>
    <h2>Con tu capital (${prefs.capital} USDT · riesgo ${prefs.riskPct}%)</h2>
    <div class="card"><div class="grid2">
      <div class="stat"><div class="k">Comprarías</div><div class="v mono">${z.amount.toFixed(2)} USDT</div></div>
      <div class="stat"><div class="k">Pérdida si toca el stop</div><div class="v mono down">${z.risk.toFixed(2)} USDT</div></div></div>
      ${z.raised ? `<div class="callout warn">Subido al mínimo de Binance: el riesgo real es ${z.riskPct.toFixed(1)}% de tu capital.</div>` : ''}
      ${!z.enough ? '<div class="callout warn">Tu capital no alcanza para esta operación.</div>' : ''}
      <p class="note">Stop en ${fmt(stop)}. Sin objetivo fijo: el stop sube cada día con el precio (máximo alcanzado − 3,5 × volatilidad) y nunca baja.</p></div>
    <h2>Historial de la estrategia en ${name(symbol)}</h2>
    <div class="card"><div class="grid3">
      <div class="stat"><div class="k">Operaciones</div><div class="v">${sim.trades.length}</div></div>
      <div class="stat"><div class="k">Ganadoras</div><div class="v">${sim.trades.length ? Math.round(sim.trades.filter((t) => t.r > 0).length / sim.trades.length * 100) : 0}%</div></div>
      <div class="stat"><div class="k">Resultado</div><div class="v ${sim.trades.reduce((s, t) => s + t.r, 0) >= 0 ? 'up' : 'down'}">${(sim.trades.reduce((s, t) => s + t.r, 0)).toFixed(1)}R</div></div></div>
      <p class="note">Últimos ~3 meses (los días anteriores se usan para calcular la media de 200). Para varios años usa “Probar”.</p>
      <a class="btn ghost block" href="#/probar?s=${symbol}">Probar 5 años en ${name(symbol)}</a></div>
    <a class="btn block" href="${binanceUrl(symbol)}" target="_blank" rel="noopener" style="margin-top:6px">Ver ${name(symbol)} en Binance</a>${DISCLAIMER}`;
}

function vProbar(params) {
  const s = params.get('s') || store.get('probarSym', 'TODAS');
  const years = +(params.get('y') || store.get('probarY', 5));
  const mode = store.get('probarMode', 'bot');
  return `<section class="hero">${robotSvg(70, 'feliz', 'pb')}<div class="bubble"><b>Laboratorio</b><span>Prueba la estrategia con años de datos reales, como si el robot hubiera operado.</span></div></section>
    <div class="card"><label class="f">Cripto<select id="pSym"><option value="TODAS" ${s === 'TODAS' ? 'selected' : ''}>Las 20 criptos (como el robot)</option>${MAJORS.map((m) => `<option value="${m}" ${m === s ? 'selected' : ''}>${name(m)}</option>`).join('')}</select></label>
    <label class="f">Periodo<select id="pY">${[2, 3, 5].map((y) => `<option value="${y}" ${y === years ? 'selected' : ''}>Últimos ${y} años</option>`).join('')}</select></label>
    <label class="f">Modo<select id="pMode"><option value="bot" ${mode === 'bot' ? 'selected' : ''}>Como mi bot (capital real, máx. abiertas)</option><option value="teo" ${mode === 'teo' ? 'selected' : ''}>Teórico (todas las señales)</option></select></label>
    <div id="pBotOpts" style="${mode === 'bot' ? '' : 'display:none'}"><div class="grid2">
      <label class="f">Capital inicial (USDT)<input id="pCap" type="number" min="10" step="any" value="${prefs.capital}"></label>
      <label class="f">Riesgo por operación (%)<input id="pRisk" type="number" min="0.1" max="5" step="0.1" value="${prefs.riskPct}"></label>
      <label class="f">Máx. operaciones abiertas<input id="pMax" type="number" min="1" max="10" step="1" value="${lab.maxOpen}"></label>
      <label class="f">Tope por orden (USDT)<input id="pTope" type="number" min="6" step="any" value="${lab.maxOrder}"></label></div></div>
    <button class="btn block" id="pRun">Probar estrategia</button>
    <p class="note">Mismas reglas que el robot: entra al día siguiente de la ruptura, stop inicial 2,5 × volatilidad, stop que sube y comisión 0,1% por lado. En modo "Como mi bot" se respetan tu capital, el máximo de operaciones abiertas, el mínimo de Binance (~6 USDT) y el tope por orden, con interés compuesto.</p></div>
    <div id="pOut"></div>`;
}

let lab = { maxOpen: 3, maxOrder: 15, ...store.get('lab', {}) };
const histCache = {};
async function runProbar() {
  const s = $('#pSym').value, y = +$('#pY').value, out = $('#pOut'), mode = $('#pMode').value;
  store.set('probarSym', s); store.set('probarY', y); store.set('probarMode', mode);
  if (mode === 'bot') { lab = { maxOpen: Math.max(1, Math.round(+$('#pMax').value || 3)), maxOrder: Math.max(6, +$('#pTope').value || 15) }; store.set('lab', lab); }
  const syms = s === 'TODAS' ? MAJORS : [s];
  out.innerHTML = loadingView(`Descargando ${y} años de datos${syms.length > 1 ? ` de ${syms.length} criptos` : ''}…`);
  try {
    const all = [], bh = [];
    let done = 0;
    await pool(syms, async (sym) => {
      const key = sym + '|' + y;
      const c = histCache[key] || (histCache[key] = await klinesHistory(sym, '1d', y * 365 + 210));
      const r = simulateTrend(c);
      r.trades.forEach((t) => all.push({ ...t, symbol: sym }));
      if (c.close.length > 215) bh.push((c.close.at(-1) / c.close[210] - 1) * 100);
      done++; const p = out.querySelector('.prog'); if (p) p.textContent = `${done}/${syms.length}`;
    }, 4);
    if (mode === 'bot') return renderBotLab(out, all, s, y, bh);
    all.sort((a, b) => a.exitTime - b.exitTime);
    const wins = all.filter((t) => t.r > 0), sumR = all.reduce((s2, t) => s2 + t.r, 0);
    const gw = wins.reduce((s2, t) => s2 + t.r, 0), gl = -all.filter((t) => t.r <= 0).reduce((s2, t) => s2 + t.r, 0);
    let cum = 0, peak = 0, dd = 0, streak = 0, ms = 0; const pts = [{ v: 0 }];
    for (const t of all) { cum += t.r * prefs.riskPct; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); streak = t.r <= 0 ? streak + 1 : 0; ms = Math.max(ms, streak); pts.push({ v: cum }); }
    const best = all.slice().sort((a, b) => b.pct - a.pct)[0];
    const bhAvg = bh.length ? bh.reduce((a, b) => a + b, 0) / bh.length : null;
    out.innerHTML = `<div class="card"><div class="row between"><b>${s === 'TODAS' ? 'Las 20 criptos' : name(s)} · ${y} años</b><span class="pill ${sumR > 0 ? 'p-ruptura' : 'p-down'}">${sumR > 0 ? 'POSITIVA' : 'NEGATIVA'}</span></div>
      <canvas class="eq" id="eq" style="margin:12px 0 4px"></canvas>
      <div class="grid3">
        <div class="stat"><div class="k">Operaciones</div><div class="v">${all.length}</div></div>
        <div class="stat"><div class="k">Ganadoras</div><div class="v">${all.length ? Math.round(wins.length / all.length * 100) : 0}%</div></div>
        <div class="stat"><div class="k">Factor benef.</div><div class="v">${gl ? (gw / gl).toFixed(2) : '–'}</div></div>
        <div class="stat"><div class="k">Resultado</div><div class="v ${cum >= 0 ? 'up' : 'down'}">${pct(cum)}</div></div>
        <div class="stat"><div class="k">Peor caída</div><div class="v down">−${dd.toFixed(1)}%</div></div>
        <div class="stat"><div class="k">Racha perdedora</div><div class="v">${ms}</div></div></div>
      <p class="note">Resultado = suma de operaciones arriesgando ${prefs.riskPct}% del capital en cada una (sin interés compuesto)${s === 'TODAS' ? ', como si pudieras tener varias abiertas a la vez' : ''}. ${bhAvg != null ? `Comprar y mantener en el mismo periodo: ${pct(bhAvg)} (promedio).` : ''} ${best ? `Mejor operación: ${name(best.symbol)} ${pct(best.pct)} en ${best.bars} días.` : ''}</p></div>
      <h2>Últimas operaciones simuladas</h2>
      <div class="card scroll"><table><tr><th>Cripto</th><th>Entrada</th><th>Días</th><th>Resultado</th></tr>
      ${all.slice(-15).reverse().map((t) => `<tr><td>${name(t.symbol)}</td><td>${date(t.entryTime)}</td><td>${t.bars}</td><td class="${t.pct >= 0 ? 'up' : 'down'}">${pct(t.pct)}</td></tr>`).join('')}</table></div>${DISCLAIMER}`;
    requestAnimationFrame(() => drawEquity($('#eq'), pts, cum >= 0 ? '#22c55e' : '#ef4444'));
  } catch (e) { out.innerHTML = `<div class="callout warn">No se pudo completar: ${esc(e.message)}</div>`; }
}

function renderBotLab(out, all, s, y, bh) {
  const capital = Math.max(10, +$('#pCap').value || prefs.capital), riskPct = Math.min(5, Math.max(0.1, +$('#pRisk').value || prefs.riskPct));
  const r = simulatePortfolio(all, { capital, riskPct, maxOpen: lab.maxOpen, maxOrder: lab.maxOrder, order: MAJORS });
  const usd = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} USDT`;
  const bhAvg = bh.length ? bh.reduce((a, b) => a + b, 0) / bh.length : null;
  // Resultado por año
  const byYear = {};
  for (const p of r.taken) { const k = new Date(p.exitTime).getUTCFullYear(); (byYear[k] ||= { n: 0, pnl: 0 }); byYear[k].n++; byYear[k].pnl += p.pnl; }
  const months = y * 12, perMonth = r.trades / months;
  const pts = r.curve.map((c) => ({ v: c.v - capital }));
  const good = r.end > capital;
  out.innerHTML = `<div class="card"><div class="row between"><b>Como tu bot · ${s === 'TODAS' ? '20 criptos' : name(s)} · ${y} años</b><span class="pill ${good ? 'p-ruptura' : 'p-down'}">${good ? 'GANA' : 'PIERDE'}</span></div>
    <div class="grid2" style="margin-top:12px">
      <div class="stat"><div class="k">Empezaste con</div><div class="v mono">${usd(capital)}</div></div>
      <div class="stat"><div class="k">Terminarías con</div><div class="v mono ${good ? 'up' : 'down'}">${usd(r.end)}</div></div></div>
    <canvas class="eq" id="eq" style="margin:12px 0 4px"></canvas>
    <div class="grid3">
      <div class="stat"><div class="k">Rentabilidad</div><div class="v ${good ? 'up' : 'down'}">${pct(r.returnPct)}</div></div>
      <div class="stat"><div class="k">Peor caída</div><div class="v down">−${r.maxDDPct.toFixed(1)}%</div></div>
      <div class="stat"><div class="k">Ganadoras</div><div class="v">${Math.round(r.winRate)}%</div></div>
      <div class="stat"><div class="k">Operaciones</div><div class="v">${r.trades}</div></div>
      <div class="stat"><div class="k">Por mes</div><div class="v">${perMonth.toFixed(1)}</div></div>
      <div class="stat"><div class="k">Sin cupo</div><div class="v">${r.skippedFull + r.skippedCash}</div></div></div>
    <p class="note">Capital ${capital} USDT, riesgo ${riskPct}% por operación, máximo ${lab.maxOpen} abiertas y tope ${lab.maxOrder} USDT por orden. "Sin cupo" son señales que el bot no habría tomado por tener el máximo de operaciones abiertas o poco saldo libre.
    ${r.best ? `Mejor: ${name(r.best.symbol)} ${usd(r.best.pnl)} (${pct(r.best.pct)}). ` : ''}${r.worst ? `Peor: ${name(r.worst.symbol)} ${usd(r.worst.pnl)}. ` : ''}${bhAvg != null ? `Comprar y mantener (promedio de las criptos): ${pct(bhAvg)}.` : ''}</p></div>
    <h2>Año por año</h2>
    <div class="card scroll"><table><tr><th>Año</th><th>Operaciones</th><th>Resultado</th></tr>
    ${Object.entries(byYear).map(([k, v]) => `<tr><td>${k}</td><td>${v.n}</td><td class="${v.pnl >= 0 ? 'up' : 'down'}">${usd(v.pnl)}</td></tr>`).join('')}</table>
    <p class="note">Mira los años malos: es normal que la estrategia pase periodos largos perdiendo de a poco. Pregúntate si podrías aguantarlos sin abandonarla.</p></div>
    <h2>Últimas operaciones que habría tomado</h2>
    <div class="card scroll"><table><tr><th>Cripto</th><th>Entrada</th><th>Monto</th><th>Resultado</th></tr>
    ${r.taken.slice(-15).reverse().map((p) => `<tr><td>${name(p.symbol)}</td><td>${date(p.entryTime)}</td><td>${p.amount.toFixed(2)}</td><td class="${p.pnl >= 0 ? 'up' : 'down'}">${usd(p.pnl)} <span class="tiny">(${pct(p.pct)})</span></td></tr>`).join('')}</table></div>${DISCLAIMER}`;
  requestAnimationFrame(() => drawEquity($('#eq'), pts, good ? '#22c55e' : '#ef4444'));
}

function vRobot() {
  const tg = prefs.botUser ? `https://t.me/${prefs.botUser.replace(/^@/, '')}` : null;
  return `<section class="hero">${robotSvg(90, 'feliz', 'rb')}<div class="bubble"><b>Hola, soy Eintes Robot</b><span>Busco rupturas de tendencia en las 20 criptos principales y te pido permiso antes de operar.</span></div></section>
    <h2>Cómo trabajo</h2>
    <div class="card"><ol class="steps">
      <li><b>Cada noche a las 21:00</b> (cierre diario) reviso BTC, ETH, SOL y 17 criptos más.</li>
      <li>Si una <b>supera su máximo de 55 días</b> estando sobre su media de 200, te escribo por Telegram.</li>
      <li>Tú decides con <b>✅ Sí</b> o <b>❌ No</b>. Sin tu “Sí” no hago nada.</li>
      <li>Compro y pongo el <b>stop en Binance</b>. Cada noche lo <b>subo</b> si el precio subió; nunca lo bajo.</li>
      <li>La operación termina cuando el precio toca el stop. Te aviso el resultado.</li></ol></div>
    <h2>Lo que mostraron las pruebas</h2>
    <div class="card"><div class="grid2">
      <div class="stat"><div class="k">Aciertos</div><div class="v">~35%</div></div>
      <div class="stat"><div class="k">Ganancia media / operación</div><div class="v up">+0,18R</div></div>
      <div class="stat"><div class="k">Señales al mes</div><div class="v">3 – 5</div></div>
      <div class="stat"><div class="k">Duración media</div><div class="v">~3 sem.</div></div></div>
      <p class="note">20 criptos, 2022–2026, con comisiones. Ganó tanto en el periodo alcista (+0,50R por operación) como en el bajista (+0,18R), cuando comprar y mantener perdió −43%. Espera rachas de pérdidas pequeñas: unas pocas ganancias grandes las compensan. R = lo que arriesgas en cada operación.</p></div>
    <h2>Comandos de Telegram</h2>
    <div class="card small"><div class="list">
      <div class="item"><code class="cmd">/estado</code><span class="muted">saldo, operaciones abiertas y resultado</span></div>
      <div class="item"><code class="cmd">/revisar</code><span class="muted">revisa el mercado ahora</span></div>
      <div class="item"><code class="cmd">/cerrar</code><span class="muted">vender una operación abierta</span></div>
      <div class="item"><code class="cmd">/pausa</code><span class="muted">no proponer compras (los stops siguen)</span></div>
      <div class="item"><code class="cmd">/reanudar</code><span class="muted">volver a proponer</span></div></div>
      ${tg ? `<a class="btn block" style="margin-top:8px" href="${tg}" target="_blank" rel="noopener">Abrir mi robot en Telegram</a>` : ''}</div>
    <h2>Mis ajustes</h2>
    <form class="card" id="prefsForm">
      <div class="grid2"><label class="f">Capital (USDT)<input name="capital" type="number" step="any" min="1" value="${prefs.capital}"></label>
      <label class="f">Riesgo por operación (%)<input name="riskPct" type="number" step="0.1" min="0.1" max="5" value="${prefs.riskPct}"></label></div>
      <label class="f">Usuario de tu bot de Telegram (ej: jhonny_senales_bot)<input name="botUser" value="${esc(prefs.botUser)}" placeholder="sin @"></label>
      <button class="btn block" type="submit">Guardar</button>
      <p class="note">Se guardan solo en este teléfono. Usa los mismos valores que el bot (riesgo 1,5% por defecto).</p></form>${DISCLAIMER}`;
}

const loadingView = (msg) => `<div class="card" style="text-align:center;padding:28px 16px">${robotSvg(72, 'calma', 'ld')}<div class="muted" style="margin-top:8px"><span class="spin"></span> ${esc(msg)} <span class="prog"></span></div></div><div class="skeleton"></div><div class="skeleton"></div>`;

// ---------------- Navegación ----------------
async function render() {
  const [path, q] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(q || ''), parts = path.split('/').filter(Boolean), tab = parts[0] || 'inicio';
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === (tab === 'moneda' ? 'mercado' : tab)));
  const needsMarket = ['inicio', 'mercado', 'moneda'].includes(tab);
  const draw = () => {
    view.innerHTML = tab === 'mercado' ? vMercado(params) : tab === 'moneda' ? vMoneda(parts[1]) : tab === 'probar' ? vProbar(params) : tab === 'robot' ? vRobot() : vInicio();
    window.scrollTo(0, 0);
    if (tab === 'mercado') applySearch();
  };
  draw();
  if (needsMarket && !state.market) { await loadMarket(); draw(); }
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go && !e.target.closest('a,button')) location.hash = go.dataset.go;
  if (e.target.id === 'pRun') runProbar();
});
function applySearch() {
  const q = (state.q || '').trim().toLowerCase(), items = document.querySelectorAll('#mList .item');
  let shown = 0;
  items.forEach((it) => { const ok = !q || it.dataset.name.includes(q); it.style.display = ok ? '' : 'none'; if (ok) shown++; });
  const none = document.getElementById('mNone'); if (none) none.style.display = items.length && !shown ? '' : 'none';
}
document.addEventListener('input', (e) => { if (e.target.id === 'mSearch') { state.q = e.target.value; applySearch(); } });
document.addEventListener('change', (e) => { if (e.target.id === 'pMode') { const o = $('#pBotOpts'); if (o) o.style.display = e.target.value === 'bot' ? '' : 'none'; } });
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'prefsForm') return;
  e.preventDefault();
  const fd = new FormData(e.target);
  prefs = { capital: Math.max(1, +fd.get('capital') || 50), riskPct: Math.min(5, Math.max(0.1, +fd.get('riskPct') || 1.5)), botUser: String(fd.get('botUser') || '').trim().replace(/^@/, '') };
  store.set('prefs2', prefs); toast('Ajustes guardados'); render();
});
$('#refresh').addEventListener('click', async () => { await loadMarket(true); render(); });
window.addEventListener('hashchange', render);
setInterval(() => { if (state.at) setStatus(ago(state.at)); }, 30e3);
setInterval(async () => { if (document.visibilityState === 'visible' && ['', '#/', '#/mercado'].includes(location.hash.split('?')[0])) { await loadMarket(true); render(); } }, 10 * 60e3);

brand();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
