// Mascota "Eintes Robot": foto del robot. El estado de ánimo cambia el brillo del marco.
// (Se mantiene el nombre robotSvg para no cambiar el resto de la app.)
export function robotSvg(size = 96, mood = 'feliz') {
  const ring = mood === 'alerta' ? '#22c55e' : mood === 'calma' ? '#64748b' : '#22d3ee';
  return `<img class="robot robot-foto ${mood}" src="robot-avatar.jpg" width="${size}" height="${size}" alt="Eintes Robot"
    style="width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.28)}px;object-fit:cover;flex:none;box-shadow:0 0 0 2px ${ring}, 0 0 ${Math.round(size * 0.22)}px ${ring}66">`;
}
