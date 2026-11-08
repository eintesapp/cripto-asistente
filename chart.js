// Gráficos en <canvas> sin librerías externas.
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtAxis = (p) => (p >= 1000 ? p.toFixed(0) : p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toPrecision(3));

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr);
  return { g, W, H };
}

/** Velas diarias + media 200 + canal de 55 días + niveles (stop, ruptura). */
export function drawTrendChart(canvas, c, x, levels = [], bars = 140) {
  const { g, W, H } = setup(canvas);
  const n = c.close.length, from = Math.max(0, n - bars), idx = [];
  for (let i = from; i < n; i++) idx.push(i);
  const right = 54, plotW = W - right, volH = H * 0.13, priceH = H - volH - 10;
  const vals = idx.flatMap((i) => [c.low[i], c.high[i], x.sma200[i], x.prevHigh[i]]).concat(levels.map((l) => l.price)).filter((v) => v != null && isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const y = (p) => 6 + (hi - p) / (hi - lo) * (priceH - 12);
  const cw = plotW / idx.length, X = (k) => k * cw + cw / 2;
  const line = css('--line'), muted = css('--muted'), up = css('--up'), down = css('--down');
  g.font = '10px -apple-system, sans-serif'; g.lineWidth = 1;
  for (let t = 0; t <= 4; t++) { const p = lo + (hi - lo) * t / 4; g.strokeStyle = line; g.beginPath(); g.moveTo(0, y(p)); g.lineTo(plotW, y(p)); g.stroke(); g.fillStyle = muted; g.fillText(fmtAxis(p), plotW + 5, y(p) + 3); }
  const vmax = Math.max(...idx.map((i) => c.volume[i])) || 1;
  idx.forEach((i, k) => { const u = c.close[i] >= c.open[i]; g.fillStyle = (u ? up : down) + '40'; const h = c.volume[i] / vmax * volH; g.fillRect(X(k) - cw * .35, H - h, cw * .7, h); });
  // Canal de 55 días (zona de ruptura)
  g.fillStyle = 'rgba(34,211,238,.07)'; g.beginPath();
  idx.forEach((i, k) => { const v = x.prevHigh[i]; if (v != null) (k ? g.lineTo(X(k), y(v)) : g.moveTo(X(k), y(v))); });
  g.lineTo(X(idx.length - 1), 0); g.lineTo(X(0), 0); g.closePath(); g.fill();
  const series = (arr, col, w = 1.6, dash = []) => { g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = w; g.beginPath(); let s = false; idx.forEach((i, k) => { const v = arr[i]; if (v == null) return; s ? g.lineTo(X(k), y(v)) : (g.moveTo(X(k), y(v)), s = true); }); g.stroke(); g.setLineDash([]); };
  series(x.prevHigh, '#22d3ee', 1.4, [4, 3]);
  series(x.sma200, '#f59e0b', 1.8);
  idx.forEach((i, k) => {
    const u = c.close[i] >= c.open[i]; g.strokeStyle = g.fillStyle = u ? up : down; g.lineWidth = 1;
    g.beginPath(); g.moveTo(X(k), y(c.high[i])); g.lineTo(X(k), y(c.low[i])); g.stroke();
    const t = y(Math.max(c.open[i], c.close[i])), b = y(Math.min(c.open[i], c.close[i])); g.fillRect(X(k) - cw * .36, t, cw * .72, Math.max(1, b - t));
    if (x.breakIdx && x.breakIdx.has(i)) { g.fillStyle = '#22c55e'; g.beginPath(); g.moveTo(X(k), y(c.high[i]) - 12); g.lineTo(X(k) - 5, y(c.high[i]) - 4); g.lineTo(X(k) + 5, y(c.high[i]) - 4); g.fill(); }
  });
  for (const l of levels) {
    g.setLineDash([6, 4]); g.strokeStyle = l.color; g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, y(l.price)); g.lineTo(plotW, y(l.price)); g.stroke(); g.setLineDash([]);
    g.fillStyle = l.color; const tw = right; g.fillRect(plotW, y(l.price) - 8, tw, 16); g.fillStyle = '#fff'; g.font = 'bold 10px -apple-system, sans-serif'; g.fillText(l.label, plotW + 4, y(l.price) + 3.5);
  }
}

/** Curva de resultado acumulado (en %). */
export function drawEquity(canvas, points, color = '#8b5cf6') {
  const { g, W, H } = setup(canvas);
  if (points.length < 2) return;
  const vals = points.map((p) => p.v), lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1;
  const y = (v) => 8 + (hi - v) / span * (H - 16), X = (k) => 4 + k / (points.length - 1) * (W - 8);
  g.strokeStyle = css('--line'); g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, y(0)); g.lineTo(W, y(0)); g.stroke(); g.setLineDash([]);
  const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
  g.beginPath(); points.forEach((p, k) => (k ? g.lineTo(X(k), y(p.v)) : g.moveTo(X(k), y(p.v)))); g.lineTo(X(points.length - 1), y(lo)); g.lineTo(X(0), y(lo)); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); points.forEach((p, k) => (k ? g.lineTo(X(k), y(p.v)) : g.moveTo(X(k), y(p.v)))); g.strokeStyle = color; g.lineWidth = 2; g.stroke();
}

/** Medidor semicircular 0–100%. */
export function gaugeSvg(pct, size = 92) {
  const r = 38, c = Math.PI * r, v = Math.max(0, Math.min(100, pct)) / 100;
  const col = pct >= 60 ? '#22c55e' : pct <= 35 ? '#ef4444' : '#f59e0b';
  return `<svg width="${size}" height="${size * 0.62}" viewBox="0 0 100 62"><path d="M12 54 A38 38 0 0 1 88 54" fill="none" stroke="var(--card2)" stroke-width="10" stroke-linecap="round"/>
  <path d="M12 54 A38 38 0 0 1 88 54" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c * v} ${c}"/>
  <text x="50" y="52" text-anchor="middle" font-size="18" font-weight="800" fill="var(--text)">${Math.round(pct)}%</text></svg>`;
}
