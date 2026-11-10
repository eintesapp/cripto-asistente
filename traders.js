// Eintes Robot · Seguimiento de traders de Copy Trading (lista propia, máximo 10).
// Binance no tiene API oficial para los rankings de Copy Trading, así que los datos
// los copias tú desde el perfil público del trader y aquí se calcula un puntaje propio.
// Todo se guarda solo en este teléfono (localStorage).

export const MAX_TRADERS = 10;
const KEY = 'traders1';

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);

// ---------------- Puntaje (0–100) ----------------
// 40% retorno ajustado por drawdown · 25% consistencia · 20% trayectoria · 15% control del riesgo.
// Luego resta puntos por señales de alerta.
export function scoreTrader(t) {
  const roi30 = num(t.roi30), roi90 = num(t.roi90), roi180 = num(t.roi180);
  const mdd = Math.abs(num(t.mdd) ?? 0), days = num(t.days) ?? 0, copiers = num(t.copiers) ?? 0;

  // 1) Retorno ajustado por drawdown: retorno mensual medio / drawdown máximo.
  const monthly = [roi30, roi90 != null ? roi90 / 3 : null, roi180 != null ? roi180 / 6 : null].filter((x) => x != null);
  const avgMonthly = monthly.length ? monthly.reduce((a, b) => a + b, 0) / monthly.length : 0;
  const ratio = avgMonthly / Math.max(mdd, 3); // piso de 3% para no premiar drawdowns irreales
  const sRet = clamp(ratio / 1.2) * 100; // 1,2 = muy bueno (ej. 6% al mes con 5% de drawdown)

  // 2) Consistencia: cuántos periodos son positivos y qué tan parecidos son mes a mes.
  const pos = monthly.filter((x) => x > 0).length;
  let similar = 0;
  if (monthly.length >= 2 && pos === monthly.length) similar = Math.min(...monthly) / Math.max(...monthly);
  // Con un solo periodo no se puede medir consistencia: máximo 40 puntos.
  const sCons = monthly.length >= 2 ? ((pos / monthly.length) * 0.6 + similar * 0.4) * 100 : monthly.length ? (pos ? 40 : 0) : 0;

  // 3) Trayectoria: días operando (1 año = completo) y copiadores (escala logarítmica, 1.000 = completo).
  const sTraj = (clamp(days / 365) * 0.7 + clamp(Math.log10(copiers + 1) / 3) * 0.3) * 100;

  // 4) Control del riesgo: drawdown 0% = 100 puntos, 40% o más = 0.
  const sRisk = clamp(1 - mdd / 40) * 100;

  let score = sRet * 0.4 + sCons * 0.25 + sTraj * 0.2 + sRisk * 0.15;

  const flags = [];
  if ((roi30 ?? 0) > 100 || (roi90 ?? 0) > 300 || (roi180 ?? 0) > 600) { score -= 15; flags.push({ cls: 'down', t: 'Rentabilidad extraordinaria: suele indicar apalancamiento alto.' }); }
  if (mdd > 40) { score -= 20; flags.push({ cls: 'down', t: `Drawdown de ${mdd.toFixed(0)}%: en algún momento perdió casi la mitad.` }); }
  else if (mdd > 25) flags.push({ cls: 'warn', t: `Drawdown de ${mdd.toFixed(0)}%: caídas fuertes posibles.` });
  if (days < 90) { score -= 15; flags.push({ cls: 'warn', t: `Historial corto (${days} días): aún no se puede juzgar.` }); }
  if (roi30 != null && roi30 < 0) flags.push({ cls: 'warn', t: 'Está perdiendo en los últimos 30 días.' });
  if (t.type === 'Futuros') flags.push({ cls: 'info', t: 'Opera futuros: usa apalancamiento. Copia con monto pequeño.' });

  score = Math.round(clamp(score, 0, 100));
  const grade = score >= 70 ? { label: 'SÓLIDO', cls: 'p-ruptura' } : score >= 50 ? { label: 'ACEPTABLE', cls: 'p-cerca' } : { label: 'RIESGOSO', cls: 'p-down' };
  return { score, grade, flags, parts: { ret: Math.round(sRet), cons: Math.round(sCons), traj: Math.round(sTraj), risk: Math.round(sRisk) } };
}

// ---------------- Almacenamiento ----------------
export function loadTraders() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function saveTraders(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} }

const FIELDS = ['roi30', 'roi90', 'roi180', 'mdd', 'days', 'copiers', 'winRate'];

// Crea o actualiza un trader. Si cambian las cifras, guarda una foto en el historial.
export function upsertTrader(list, data, now = Date.now()) {
  const clean = {
    name: String(data.name || '').trim().slice(0, 40),
    link: /^https:\/\/(www\.)?binance\.com\//.test(String(data.link || '').trim()) ? String(data.link).trim() : '',
    type: data.type === 'Spot' ? 'Spot' : 'Futuros',
    note: String(data.note || '').trim().slice(0, 140),
  };
  for (const f of FIELDS) clean[f] = num(data[f]);
  if (!clean.name) throw new Error('Escribe el nombre del trader.');
  if (clean.roi30 == null && clean.roi90 == null) throw new Error('Necesito al menos el ROI de 30 o 90 días.');
  if (clean.mdd == null) throw new Error('Falta el drawdown máximo (MDD).');

  const out = list.slice();
  let t = data.id ? out.find((x) => x.id === data.id) : null;
  if (!t) {
    if (out.length >= MAX_TRADERS) throw new Error(`Tu lista ya tiene ${MAX_TRADERS} traders. Elimina uno para agregar otro.`);
    t = { id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 6), fav: false, history: [], created: now };
    out.push(t);
  }
  const changed = FIELDS.some((f) => t[f] !== clean[f]);
  Object.assign(t, clean, { updated: now });
  if (changed) {
    t.history = [...(t.history || []), { at: now, ...Object.fromEntries(FIELDS.map((f) => [f, clean[f]])), score: scoreTrader(t).score }].slice(-24);
  }
  return out;
}

export function ranked(list) {
  return list.map((t) => ({ t, s: scoreTrader(t) })).sort((a, b) => (b.t.fav - a.t.fav) || (b.s.score - a.s.score));
}

// Respaldo: texto que se puede copiar/pegar para pasar la lista a otro teléfono.
export function exportBackup(list) { return JSON.stringify({ app: 'eintes-traders', v: 1, list }); }
export function importBackup(text) {
  const d = JSON.parse(text);
  if (d?.app !== 'eintes-traders' || !Array.isArray(d.list)) throw new Error('Ese texto no es un respaldo de Eintes Robot.');
  return d.list.slice(0, MAX_TRADERS);
}
