# Eintes Robot · Bitácora del proyecto

> Si abres un chat nuevo con Claude, pega el enlace del repositorio (https://github.com/eintesapp/cripto-asistente) y di: "lee PROGRESO.md y continuemos". Con este archivo se retoma todo.

Última actualización: 9 de noviembre de 2026 · versión 2.6

## Qué es
Asistente de trading personal para Binance (uso propio, no comercial por ahora):
- **App (PWA)** en el celular: https://eintesapp.github.io/cripto-asistente/
- **Bot de Telegram** que propone compras y solo opera si respondo **✅ Sí** (con ❌ No no hace nada).
- **Escáner automático** en GitHub Actions (`.github/workflows/escaner.yml`) que guarda resultados en `data/`.

## Estrategia elegida
**Ruptura 55 diario**: compra cuando una de las 20 criptos principales cierra sobre su máximo de 55 días estando sobre su media de 200. Stop por ATR que se sube cada noche (nunca se baja). Revisión diaria a las 21:00 (Chile).
- Backtest 2022–2026 con comisiones: ~35% de aciertos, +0,18R por operación, 3–5 señales al mes, ~3 semanas por operación.

## Estado actual
- [x] App Eintes Robot con pestañas Inicio, Mercado, Probar (backtest), **Traders** y Robot
- [x] Bot de Telegram con comandos /estado, /revisar, /cerrar, /pausa, /reanudar
- [x] Bot corriendo en mi PC con Windows por las noches (`iniciar-bot-windows.bat`)
- [x] Modo papel/demo (Binance Testnet) para probar sin dinero real
- [x] **v2.6: seguimiento de hasta 10 traders de Copy Trading** con puntaje propio (ver README, sección Fase 7)
- [ ] Pasar a dinero real antes de fines de noviembre 2026, con montos pequeños
- [ ] Conseguir un equipo que quede encendido de día (Oracle Cloud gratis no tenía capacidad)
- [ ] Seguir afinando estrategias según resultados

## Configuración del bot (`bot-config.json`)
Orden de 7 USDT, máximo 10 USDT por orden, 1 operación abierta a la vez, pérdida diaria máxima 0,5 USDT.

## Seguridad (importante)
- El repositorio es **público**: **nunca** subir el archivo `.env` ni claves de Binance o el token de Telegram.
- Las claves reales están solo en el `.env` de mi PC. Respaldarlas en un lugar privado (gestor de contraseñas), no en GitHub.
- Claves de Binance: sin permiso de retiro y, si es posible, con IP restringida.
- La lista de traders vive solo en el teléfono: usar **Traders → Respaldo de la lista** y guardar el texto.

## Historial de cambios
- **2.6 (9 nov 2026):** pestaña Traders (ranking, alertas, evolución, favoritos, respaldo) y los 3 mejores en Inicio.
- **2.5:** versión Eintes Robot con estrategia Ruptura 55, robot con mascota, accesos rápidos a Binance y P2P.
- **1.x:** Cripto Señales: señales por confluencia de indicadores, escáner cada 15 min y alertas a Telegram.
