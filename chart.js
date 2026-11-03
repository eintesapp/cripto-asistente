// Gráfico de velas liviano en <canvas> (sin librerías externas).
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function drawChart(canvas, c, ind, sig, bars = 120) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const n = c.close.length, from = Math.max(0, n - bars);
  const idx = Array.from({ length: n - from }, (_, k) => from + k);
  const priceH = H * 0.66, volTop = priceH + 4, volH = H * 0.1, rsiTop = volTop + volH + 8, rsiH = H - rsiTop - 4;
  const right = 52, plotW = W - right;
  const extra = [sig?.sl, sig?.tp1, sig?.tp2, sig?.entry].filter((x) => x);
  let lo = Math.min(...idx.map((i) => c.low[i]), ...extra), hi = Math.max(...idx.map((i) => c.high[i]), ...extra);
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const y = (p) => 6 + (hi - p) / (hi - lo) * (priceH - 12);
  const cw = plotW / idx.length;
  const x = (k) => k * cw + cw / 2;
  const muted = css('--muted'), line = css('--line'), buy = css('--buy'), sell = css('--sell'), warn = css('--warn'), accent = css('--accent');

  g.font = '10px sans-serif'; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
  for (let t = 0; t <= 4; t++) {
    const p = lo + (hi - lo) * t / 4, yy = y(p);
    g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke();
    g.fillText(fmt(p), plotW + 4, yy + 3);
  }
  // Volumen
  const vmax = Math.max(...idx.map((i) => c.volume[i]));
  idx.forEach((i, k) => {
    const up = c.close[i] >= c.open[i];
    g.fillStyle = up ? buy + '55' : sell + '55';
    const h = c.volume[i] / vmax * volH;
    g.fillRect(x(k) - cw * 0.35, volTop + volH - h, cw * 0.7, h);
  });
  // Velas
  idx.forEach((i, k) => {
    const up = c.close[i] >= c.open[i];
    g.strokeStyle = g.fillStyle = up ? buy : sell;
    g.beginPath(); g.moveTo(x(k), y(c.high[i])); g.lineTo(x(k), y(c.low[i])); g.stroke();
    const top = y(Math.max(c.open[i], c.close[i])), bot = y(Math.min(c.open[i], c.close[i]));
    g.fillRect(x(k) - cw * 0.35, top, cw * 0.7, Math.max(1, bot - top));
  });
  // Medias
  const series = [[ind.ema21, '#4c8dff'], [ind.ema50, '#b36bff'], [ind.sma200, '#ff9f43']];
  for (const [s, col] of series) {
    g.strokeStyle = col; g.lineWidth = 1.4; g.beginPath(); let started = false;
    idx.forEach((i, k) => { if (s[i] == null) return; const yy = y(s[i]); if (!started) { g.moveTo(x(k), yy); started = true; } else g.lineTo(x(k), yy); });
    g.stroke();
  }
  // Niveles de la señal
  const lvl = (p, col, label, dash = []) => {
    if (!p) return;
    g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(0, y(p)); g.lineTo(plotW, y(p)); g.stroke(); g.setLineDash([]);
    g.fillStyle = col; g.fillRect(plotW, y(p) - 7, right, 14);
    g.fillStyle = '#fff'; g.fillText(label, plotW + 3, y(p) + 3);
  };
  if (sig) {
    if (sig.support) lvl(sig.support, muted, 'Sop', [2, 3]);
    if (sig.resistance) lvl(sig.resistance, muted, 'Res', [2, 3]);
    if (sig.action === 'COMPRA' || sig.action === 'VENTA') {
      lvl(sig.entry, accent, 'Entrada'); lvl(sig.sl, sell, 'SL'); lvl(sig.tp1, buy, 'TP1', [5, 3]); lvl(sig.tp2, buy, 'TP2');
    }
  }
  // RSI
  g.strokeStyle = line; g.strokeRect(0, rsiTop, plotW, rsiH);
  const ry = (v) => rsiTop + (100 - v) / 100 * rsiH;
  g.setLineDash([3, 3]);
  for (const v of [30, 70]) { g.beginPath(); g.moveTo(0, ry(v)); g.lineTo(plotW, ry(v)); g.stroke(); }
  g.setLineDash([]); g.strokeStyle = warn; g.lineWidth = 1.3; g.beginPath();
  let st = false;
  idx.forEach((i, k) => { const v = ind.rsi[i]; if (v == null) return; if (!st) { g.moveTo(x(k), ry(v)); st = true; } else g.lineTo(x(k), ry(v)); });
  g.stroke();
  g.fillStyle = muted; g.fillText('RSI ' + (ind.rsi[n - 1]?.toFixed(0) ?? ''), plotW + 4, rsiTop + 10);
}

export function drawEquity(canvas, curves) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  const all = curves.flatMap((cv) => cv.points.map((p) => p.equity));
  if (!all.length) return;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  g.font = '10px sans-serif';
  curves.forEach((cv) => {
    g.strokeStyle = cv.color; g.lineWidth = 1.6; g.beginPath();
    cv.points.forEach((p, k) => { const xx = k / (cv.points.length - 1 || 1) * (W - 4) + 2, yy = 4 + (hi - p.equity) / span * (H - 8); k ? g.lineTo(xx, yy) : g.moveTo(xx, yy); });
    g.stroke();
  });
}

function fmt(p) { return p >= 1000 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p.toPrecision(3); }
