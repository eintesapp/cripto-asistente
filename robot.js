// Mascota original "Eintes Robot" en SVG (sin imágenes externas).
// mood: 'feliz' | 'alerta' | 'calma'
export function robotSvg(size = 96, mood = 'feliz', id = 'r') {
  const mouth = mood === 'alerta'
    ? '<ellipse cx="60" cy="78" rx="7" ry="6" fill="#0b1224"/>'
    : mood === 'calma'
      ? '<rect x="48" y="76" width="24" height="4" rx="2" fill="#0b1224"/>'
      : '<path d="M46 74 Q60 86 74 74" stroke="#0b1224" stroke-width="4.5" fill="none" stroke-linecap="round"/>';
  return `<svg class="robot" width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Eintes Robot">
  <defs>
    <linearGradient id="${id}h" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient>
    <radialGradient id="${id}g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fef08a"/><stop offset="1" stop-color="#f59e0b"/></radialGradient>
  </defs>
  <line x1="60" y1="14" x2="60" y2="28" stroke="#94a3b8" stroke-width="4" stroke-linecap="round"/>
  <circle class="antena" cx="60" cy="11" r="7" fill="url(#${id}g)"/>
  <rect x="8" y="50" width="10" height="24" rx="5" fill="#64748b"/>
  <rect x="102" y="50" width="10" height="24" rx="5" fill="#64748b"/>
  <rect x="16" y="26" width="88" height="76" rx="26" fill="url(#${id}h)"/>
  <rect x="26" y="38" width="68" height="52" rx="18" fill="#e0f2fe"/>
  <g class="ojos">
    <circle cx="45" cy="58" r="7.5" fill="#0b1224"/><circle cx="75" cy="58" r="7.5" fill="#0b1224"/>
    <circle cx="47.5" cy="55.5" r="2.4" fill="#fff"/><circle cx="77.5" cy="55.5" r="2.4" fill="#fff"/>
  </g>
  ${mouth}
  <circle cx="34" cy="74" r="4" fill="#f472b6" opacity=".45"/><circle cx="86" cy="74" r="4" fill="#f472b6" opacity=".45"/>
  <rect x="44" y="104" width="32" height="8" rx="4" fill="#475569"/>
</svg>`;
}
