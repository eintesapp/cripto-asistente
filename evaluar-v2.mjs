// Evaluación v2: compara estrategias DISTINTAS con datos reales de Binance.
// Solo criptomonedas principales (sin acciones tokenizadas). Sin información futura:
// señal al cierre de la vela, entrada en la apertura de la siguiente, comisión 0,1% por lado,
// si el precio abre bajo el stop se sale a ese precio (peor caso).
//
// Uso (en la carpeta del bot):  node evaluar-v2.mjs
// Resultado: resultado-v2.html y resultado-v2.json (envía el .json a Claude)
import { writeFile } from 'node:fs/promises';
import { klinesHistory, pool } from './binance.js';
import { sma, ema, rsi, atr } from './indicators.js';
import { backtest } from './backtest.js';

const MAJORS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX', 'DOT', 'LTC', 'BCH', 'NEAR', 'UNI', 'ATOM', 'XLM', 'ETC', 'APT', 'SUI'].map((s) => s + 'USDT');
const TESTS = [
  { tf: '1h', bars: 8760, htf: '4h' },  // ≈ 1 año
  { tf: '4h', bars: 4500, htf: '1d' },  // ≈ 2 años
  { tf: '1d', bars: 1800, htf: null },  // ≈ 5 años
];
const NEED = { '1h': 8760, '4h': 4500, '1d': 1800 };
const FEE = 0.001, TRAIN = 0.6;

const t0 = Date.now();
console.log('== Evaluación v2: estrategias distintas, solo criptos principales ==');
const data = {};
const jobs = MAJORS.flatMap((s) => Object.keys(NEED).map((tf) => ({ s, tf })));
let done = 0;
await pool(jobs, async ({ s, tf }) => {
  try { (data[s] ||= {})[tf] = await klinesHistory(s, tf, NEED[tf]); } catch (e) { console.log(`\n(sin datos de ${s} ${tf}: ${e.message})`); }
  done++; process.stdout.write(`\rDescargando velas: ${done}/${jobs.length}   `);
}, 4);
console.log('');

// ---------- Indicadores por serie ----------
function prep(c) {
  const hh = (n) => c.high.map((_, i) => (i < n ? null : Math.max(...c.high.slice(i - n, i)))); // máximo de las n velas ANTERIORES
  return {
    sma5: sma(c.close, 5), sma200: sma(c.close, 200), ema21: ema(c.close, 21), ema50: ema(c.close, 50),
    rsi2: rsi(c.close, 2), atr14: atr(c.high, c.low, c.close, 14), dc20: hh(20), dc55: hh(55),
  };
}

// ---------- Estrategias (solo compras) ----------
// Cada una decide al cierre de la vela i. Devuelve { slAtr, trail, tpAtr?, exit?(i), maxBars }
const STRATS = {
  T20: { name: 'Ruptura 20 velas + stop que sube (3 ATR)', enter: (c, x, i) => x.sma200[i] && c.close[i] > x.sma200[i] && c.close[i] > x.dc20[i] && c.close[i - 1] <= x.dc20[i - 1], plan: { slAtr: 2, trail: 3, maxBars: 300 } },
  T55: { name: 'Ruptura 55 velas + stop que sube (3 ATR)', enter: (c, x, i) => x.sma200[i] && c.close[i] > x.sma200[i] && c.close[i] > x.dc55[i] && c.close[i - 1] <= x.dc55[i - 1], plan: { slAtr: 2.5, trail: 3.5, maxBars: 400 } },
  EMA: { name: 'Cruce EMA 21/50 en tendencia + stop que sube', enter: (c, x, i) => x.sma200[i] && c.close[i] > x.sma200[i] && x.ema21[i - 1] <= x.ema50[i - 1] && x.ema21[i] > x.ema50[i], plan: { slAtr: 2, trail: 3, maxBars: 300, exit: (c, x, i) => x.ema21[i] < x.ema50[i] } },
  PB: { name: 'Retroceso en tendencia (RSI2<10 sobre SMA200), sale al rebote', enter: (c, x, i) => x.sma200[i] && c.close[i] > x.sma200[i] && x.rsi2[i] < 10, plan: { slAtr: 2.5, trail: 0, maxBars: 12, exit: (c, x, i) => c.close[i] > x.sma5[i] } },
};

function simulate(c, x, strat, allow) {
  const trades = []; let pos = null;
  const n = c.close.length;
  for (let i = 205; i < n - 1; i++) {
    if (pos && i >= pos.k) {
      let exitPx = null, why = '';
      if (c.low[i] <= pos.sl) { exitPx = Math.min(pos.sl, c.open[i]); why = 'SL'; }
      else {
        pos.high = Math.max(pos.high, c.high[i]);
        if (strat.plan.trail && x.atr14[i]) pos.sl = Math.max(pos.sl, pos.high - strat.plan.trail * x.atr14[i]);
        if (strat.plan.exit && strat.plan.exit(c, x, i)) { exitPx = c.close[i]; why = 'regla'; }
        else if (i - pos.k >= strat.plan.maxBars) { exitPx = c.close[i]; why = 'tiempo'; }
      }
      if (exitPx != null) {
        const r = ((exitPx - pos.entry) - (exitPx + pos.entry) * FEE) / pos.riskUnit;
        trades.push({ entryTime: c.time[pos.k], exitTime: c.closeTime[i], r, bars: i - pos.k + 1, why });
        pos = null;
      }
    }
    if (pos || !x.atr14[i] || !strat.enter(c, x, i)) continue;
    if (allow && !allow(c.closeTime[i])) continue;
    const entry = c.open[i + 1], sl = entry - strat.plan.slAtr * x.atr14[i];
    pos = { k: i + 1, entry, sl, high: entry, riskUnit: entry - sl + (entry + sl) * FEE };
  }
  return trades;
}

// Filtro de mercado: BTC sobre su SMA 200 en la misma temporalidad
function btcFilter(tf) {
  const b = data.BTCUSDT?.[tf]; if (!b) return null;
  const s = sma(b.close, 200);
  return (t) => { let lo = 0, hi = b.closeTime.length - 1, j = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b.closeTime[m] <= t) { j = m; lo = m + 1; } else hi = m - 1; } return j >= 0 && s[j] != null && b.close[j] > s[j]; };
}

const sum = (a) => a.reduce((s, v) => s + v, 0);
function stats(tr, months) {
  const t = [...tr].sort((a, b) => a.exitTime - b.exitTime), rs = t.map((v) => v.r);
  let cum = 0, peak = 0, dd = 0, st = 0, ms = 0;
  for (const r of rs) { cum += r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); st = r <= 0 ? st + 1 : 0; ms = Math.max(ms, st); }
  const gw = sum(rs.filter((r) => r > 0)), gl = -sum(rs.filter((r) => r <= 0));
  return { trades: t.length, perMonth: months ? +(t.length / months).toFixed(1) : null, winRate: t.length ? +(rs.filter((r) => r > 0).length / t.length * 100).toFixed(1) : 0,
    avgR: t.length ? +(sum(rs) / t.length).toFixed(3) : 0, totalR: +sum(rs).toFixed(1), profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : (gw > 0 ? 99 : 0),
    maxDDR: +dd.toFixed(1), maxLosingStreak: ms, avgBars: t.length ? +(sum(t.map((v) => v.bars)) / t.length).toFixed(1) : 0 };
}

const results = {};
for (const { tf, htf } of TESTS) {
  const ref = data.BTCUSDT?.[tf]; if (!ref) continue;
  const from = ref.time[205], to = ref.closeTime.at(-1), split = from + (to - from) * TRAIN;
  const mTrain = (split - from) / (30 * 864e5), mTest = (to - split) / (30 * 864e5);
  const allow = btcFilter(tf);
  const rows = [
    ...Object.entries(STRATS).map(([id, s]) => ({ id, name: s.name, strat: s, filter: null })),
    { id: 'T20+BTC', name: 'Ruptura 20 + solo si BTC sobre SMA200', strat: STRATS.T20, filter: allow },
    { id: 'PB+BTC', name: 'Retroceso + solo si BTC sobre SMA200', strat: STRATS.PB, filter: allow },
  ];
  if (tf !== '1d') rows.unshift({ id: 'A', name: 'Bot actual (referencia)', bot: true });
  const out = rows.map((r) => ({ ...r, train: [], test: [], sym: {} }));
  const bh = [];
  for (const s of MAJORS) {
    const c = data[s]?.[tf]; if (!c || c.close.length < 400) continue;
    process.stdout.write(`\rAnalizando ${tf}: ${s.padEnd(10)}`);
    const x = prep(c);
    const k0 = c.time.findIndex((t) => t >= split);
    if (k0 > 0) bh.push({ s, train: (c.close[k0] / c.close[205] - 1) * 100, test: (c.close.at(-1) / c.close[k0] - 1) * 100 });
    for (const row of out) {
      let tr;
      if (row.bot) {
        const h = htf ? data[s]?.[htf] : null;
        tr = backtest(c, h, { longOnly: true, relativeLevels: true, entryTolerancePct: 0.6, maxBars: 48, minQuality: 'media', allowCaution: false, exitMode: 'tp1', opts: { minRR: 2 } }).tradeList;
      } else tr = simulate(c, x, row.strat, row.filter);
      for (const t of tr) (t.entryTime < split ? row.train : row.test).push(t);
      row.sym[s] = stats(tr);
    }
  }
  console.log('');
  results[tf] = {
    from: new Date(from).toISOString().slice(0, 10), split: new Date(split).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10),
    buyHold: { avgTrainPct: +(sum(bh.map((b) => b.train)) / bh.length).toFixed(1), avgTestPct: +(sum(bh.map((b) => b.test)) / bh.length).toFixed(1) },
    rows: out.map((r) => {
      const tr = stats(r.train, mTrain), te = stats(r.test, mTest);
      const syms = Object.values(r.sym).filter((v) => v.trades >= 3);
      const posShare = syms.length ? Math.round(syms.filter((v) => v.totalR > 0).length / syms.length * 100) : 0;
      const candidate = tr.avgR > 0.05 && te.avgR > 0.05 && tr.profitFactor >= 1.15 && te.profitFactor >= 1.15 && te.trades >= 30 && posShare >= 55;
      const verdict = candidate ? 'CANDIDATA' : (tr.avgR > 0 && te.avgR > 0) ? 'Positiva pero débil' : te.trades < 30 ? 'Pocos datos' : 'Pierde';
      return { id: r.id, name: r.name, train: tr, test: te, coinsPositivePct: posShare, verdict, bySymbol: r.sym };
    }),
  };
}

const outJson = { version: 2, generatedAt: new Date().toISOString(), minutes: +((Date.now() - t0) / 60000).toFixed(1), symbols: MAJORS.filter((s) => data[s]), results };
await writeFile(new URL('./resultado-v2.json', import.meta.url), JSON.stringify(outJson, null, 1));
await writeFile(new URL('./resultado-v2.html', import.meta.url), html(outJson));

for (const [tf, r] of Object.entries(results)) {
  console.log(`\n--- ${tf}  (entrenamiento ${r.from} → ${r.split} · validación → ${r.to}) · comprar y mantener promedio: ${r.buyHold.avgTestPct}% en validación ---`);
  console.log('Estrategia  Ops(val)  %Gan  R/op(val)  R/op(ent)  PF(val)  %monedas+  Veredicto');
  for (const x of r.rows) console.log(`${x.id.padEnd(10)}  ${String(x.test.trades).padEnd(8)}  ${String(x.test.winRate).padEnd(4)}  ${String(x.test.avgR).padEnd(9)}  ${String(x.train.avgR).padEnd(9)}  ${String(x.test.profitFactor).padEnd(7)}  ${String(x.coinsPositivePct + '%').padEnd(9)}  ${x.verdict}`);
}
console.log(`\nListo en ${outJson.minutes} min. Envía a Claude el archivo "resultado-v2.json" o una captura de esta tabla.`);

function html(o) {
  const c = (v) => `<span style="color:${v > 0 ? '#16c784' : v < 0 ? '#ea3943' : 'inherit'}">${v > 0 ? '+' : ''}${v}</span>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evaluación v2</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#0d1220;color:#e8ecf4;margin:0;padding:16px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid #2a3550;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left;white-space:normal}.s{overflow-x:auto}.m{color:#8f9bb3}</style></head><body>
<h1>Evaluación v2: estrategias distintas</h1><p class="m">${o.symbols.length} criptos principales · comisión 0,1% por lado · R = lo arriesgado por operación · CANDIDATA = positiva en entrenamiento y validación, PF ≥ 1,15 y gana en la mayoría de las monedas.</p>
${Object.entries(o.results).map(([tf, r]) => `<h2>${tf}</h2><p class="m">Entrenamiento ${r.from} → ${r.split} · Validación → ${r.to} · Comprar y mantener (promedio en validación): ${r.buyHold.avgTestPct}%</p>
<div class="s"><table><tr><th>Estrategia</th><th>Ops val.</th><th>Ops/mes</th><th>% gan.</th><th>R/op val.</th><th>R/op entr.</th><th>PF val.</th><th>Peor caída R</th><th>% monedas +</th><th>Veredicto</th></tr>
${r.rows.map((x) => `<tr><td><b>${x.id}</b> ${x.name}</td><td>${x.test.trades}</td><td>${x.test.perMonth}</td><td>${x.test.winRate}%</td><td>${c(x.test.avgR)}</td><td>${c(x.train.avgR)}</td><td>${x.test.profitFactor}</td><td>${x.test.maxDDR}</td><td>${x.coinsPositivePct}%</td><td><b>${x.verdict}</b></td></tr>`).join('')}</table></div>`).join('')}
<p class="m">Los resultados pasados no garantizan resultados futuros.</p></body></html>`;
}
