# Cripto Señales: asistente de trading para Binance (versión 1)

App instalable en el celular (PWA) que analiza el mercado con **datos públicos de Binance**, genera señales por confluencia de indicadores, calcula el riesgo de cada operación y envía alertas a **Telegram** aunque tengas la app cerrada.

**Modo solo análisis:** no usa claves API, no accede a tu cuenta y no ejecuta operaciones.

> No es asesoría financiera. Las señales no garantizan ganancias. Usa siempre Stop Loss.

---

## 1. Arquitectura (100% gratis)

```
 ┌──────────────── Tu celular ────────────────┐        ┌──────────── GitHub (gratis) ─────────────┐
 │ PWA (GitHub Pages)                          │        │ GitHub Actions cada 15 min              │
 │  • Inicio, señales, gráfico, riesgo         │◄──────│  scanner/scan.mjs                        │
 │  • Análisis EN VIVO desde el teléfono  ─────┼──┐    │   → mismo motor de la app                │
 │  • Backtesting con historial real           │  │    │   → guarda data/*.json (señales,         │
 │  • Ranking de traders (datos tuyos)         │  │    │     historial y resultado real)          │
 └─────────────────────────────────────────────┘  │    │   → envía alertas a Telegram ──► 📱      │
                                                  ▼    └───────────────┬──────────────────────────┘
                                   API pública de Binance ◄────────────┘
                                   (data-api.binance.vision)
```

| Pieza | Tecnología | Costo |
|---|---|---|
| Interfaz | HTML + JavaScript sin dependencias, PWA instalable | 0 |
| Motor de análisis | `engine/` (lo comparten la app y el escáner) | 0 |
| Servicio automático | GitHub Actions con cron cada 15 min | 0 |
| Base de datos | Archivos JSON versionados en el repositorio (`data/`) | 0 |
| Alertas | Bot de Telegram, más notificaciones del navegador con la app abierta | 0 |
| Hosting | GitHub Pages | 0 |

### Estructura

```
index.html, app.js, chart.js, styles.css   → interfaz
manifest.webmanifest, sw.js, icons/        → instalación como app
engine/indicators.js  → RSI, MACD, EMA, SMA, Bollinger, ATR, pivotes, Fibonacci
engine/signals.js     → motor de señales por confluencia y detección de eventos
engine/risk.js        → tamaño de posición, pérdida diaria
engine/backtest.js    → simulación histórica sin información futura
engine/binance.js     → datos públicos de Binance (con reintentos y límite de peticiones)
engine/scan.js        → escaneo completo del mercado
scanner/scan.mjs      → escáner automático + Telegram
config.json           → configuración del escáner
.github/workflows/escaner.yml → ejecución cada 15 minutos
test/                 → pruebas automáticas
```

---

## 2. Cómo funcionan las señales

Cada indicador suma puntos a favor de la compra o de la venta. **Ningún indicador por sí solo genera una señal**: por ejemplo, el RSI en sobreventa suma solo 0,5 y únicamente si el precio confirma.

| Factor | Puntos |
|---|---|
| Precio sobre/bajo la SMA 200 | 1 |
| EMAs 9 > 21 > 50 alineadas | 2 |
| MACD con impulso / cruce reciente | 1 + 1 |
| RSI entre 50 y 70 subiendo (o entre 30 y 50 bajando) | 1 |
| Volumen ≥ 1,5× el promedio en la dirección de la vela | 1 |
| Ruptura de resistencia/soporte con volumen | 2 |
| Bollinger con volumen, zona Fibonacci 0,5–0,618 | 0,5 c/u |
| Temporalidad superior a favor (5m→1h, 15m→4h, 1h→4h, 4h→1d) | 1 |

Hay **COMPRA** cuando se cumplen todas estas condiciones:

- ≥ 5 puntos a favor.
- ≤ 2 puntos en contra.
- La temporalidad superior no es bajista.
- La relación riesgo/beneficio hasta TP2 es ≥ tu mínimo (2 por defecto).

Si las señales son contradictorias, el resultado es **ESPERAR**.

### Niveles

- **Stop Loss:** bajo el soporte más cercano, si queda entre 1 y 3 ATR. Si no, a 1,5 ATR.
- **TP1:** la resistencia siguiente, o 1,5R.
- **TP2:** 3R, o antes si hay otra resistencia en el camino.

### Calidad

- **Alta:** ≥ 7 puntos, temporalidad superior alineada y volumen confirmado.
- **Media:** ≥ 5,5 puntos.
- **Baja:** el resto.

Baja un nivel (y aparece el aviso **PRECAUCIÓN**) cuando hay volatilidad anormal, el precio está muy alejado de la EMA 21, hay una resistencia cerca o el RSI es extremo.

La **puntuación técnica (x/10)** cuenta indicadores; no es una probabilidad. La única cifra de acierto válida es la que mide la app con datos reales, en *Historial* y en *Backtesting*.

---

## 3. Publicar la app en tu celular (Fase 9, unos 15 minutos desde un computador)

1. Crea una cuenta gratis en <https://github.com>.
2. Crea un repositorio nuevo:
   - Botón **New**.
   - Nombre: `cripto-asistente`.
   - Visibilidad: **Public**. En repos públicos, Actions y Pages son gratis e ilimitados.
3. En el repositorio, haz clic en **Add file → Upload files**. Arrastra **todo el contenido** de esta carpeta, incluida la carpeta `.github` (si tu sistema la oculta, muestra los archivos ocultos) y presiona **Commit**.
4. Activa la página: **Settings → Pages → Source: Deploy from a branch → Branch: main / (root) → Save**. En 1–2 minutos estará en `https://TU-USUARIO.github.io/cripto-asistente/`.
5. Permite que el escáner guarde resultados: **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**.
6. Indica la dirección de tu app: **Settings → Secrets and variables → Actions → pestaña Variables → New variable**.
   - Nombre: `APP_URL`.
   - Valor: tu dirección del paso 4.
7. Instálala en el celular:
   - **Android (Chrome):** abre la dirección → menú ⋮ → *Instalar app* (o *Agregar a pantalla principal*).
   - **iPhone (Safari):** abre la dirección → botón Compartir → *Agregar a inicio*.

## 4. Alertas a Telegram con la app cerrada (Fase 6)

1. En Telegram, abre **@BotFather**, envía `/newbot` y sigue los pasos. Te entregará un **token** (ejemplo `123456:ABC...`).
2. Abre tu bot nuevo y envíale cualquier mensaje.
3. Abre en el navegador `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` y copia el número que aparece en `"chat":{"id":...}`.
4. En GitHub, ve a **Settings → Secrets and variables → Actions → New repository secret** y crea:
   - `TELEGRAM_BOT_TOKEN` = el token.
   - `TELEGRAM_CHAT_ID` = el número.
5. Ve a la pestaña **Actions → Escáner de mercado → Run workflow** para probarlo. Revisa el registro (*log*): debe decir `Listo: ... análisis`.

Desde ahí se ejecuta solo cada ~15 minutos. GitHub puede retrasarlo unos minutos en horas de alta demanda. Cada mensaje incluye un resumen y el enlace *Abrir análisis completo*.

**Antirepetición:** una misma señal no se repite durante 4 h (15m), 12 h (1h), 24 h (4h) o 72 h (1d).

### Ajustes del escáner (`config.json`)

| Campo | Qué controla |
|---|---|
| `topN` | Cuántas monedas analizar (por volumen) |
| `extraSymbols` | Monedas extra, ej. `["PEPEUSDT"]` |
| `alertTimeframes` | Temporalidades que generan alertas |
| `alertMinQuality` | `"media"` o `"alta"` (recomendado para recibir menos y mejores alertas) |
| `bigDrop24hPct` | Caída en 24 h que dispara una alerta |
| `minRR` | Relación riesgo/beneficio mínima |

### Plan B si Binance bloquea el servidor

Los servidores de GitHub están en EE.UU. y Binance restringe algunas regiones (error **451**). El escáner usa `data-api.binance.vision`, el endpoint oficial de solo datos de mercado. Si aun así el registro muestra 451, hay dos opciones:

- Ejecutar `node scanner/scan.mjs` en un computador o servidor fuera de EE.UU. con una tarea programada. En Windows, el *Programador de tareas*. Otra opción gratuita es una VM *Always Free* de Oracle Cloud en Santiago.
- La app del celular siempre funciona, porque consulta Binance directamente desde Chile.

---

## 5. Usar la app

| Pantalla | Qué ves |
|---|---|
| **Inicio** | Estado del mercado, BTC/ETH, mejores oportunidades, conteo de compras y ventas, alertas activas, ranking de traders e historial |
| **Señales** | Filtros por acción, temporalidad y calidad. Toca una señal para ver el análisis completo |
| **Análisis** | Gráfico con EMAs, SMA 200, RSI, volumen y niveles. Muestra los 12 datos de la señal, la justificación, el tamaño de posición según tu capital y el enlace a Binance para operar a mano |
| **Historial** | Cada alerta enviada y si terminó en TP1, TP2 o SL. Incluye el % real de acierto y el resultado en R |
| **Traders** | Ranking propio ajustado por riesgo (ver más abajo) |
| **Más → Backtesting** | Compara 4 estrategias con hasta 5.000 velas reales, con comisiones, drawdown y factor de beneficio |
| **Más → Riesgo** | Registra el resultado de tus operaciones. Si llegas a tu pérdida diaria máxima, la app te advierte que no operes. También controla la exposición por moneda |
| **Más → Ajustes** | Capital, % de riesgo, R/B mínimo, pérdida diaria, exposición, comisión, monedas y notificaciones |

### Sobre el seguimiento de traders (Fase 7)

Binance **no publica una API oficial** para los rankings de Copy Trading. Las direcciones internas que usa su web no están autorizadas para terceros, así que la app no las usa.

**Alternativa legal:** abres el perfil público del trader, copias ROI 30/90/180, drawdown, días y copiadores, y la app calcula el puntaje:

- 40% retorno ajustado por drawdown.
- 25% consistencia.
- 20% trayectoria.
- 15% control del riesgo.

Además resta puntos y avisa cuando detecta:

- Rentabilidad extraordinaria (señal de apalancamiento alto).
- Drawdown mayor a 40%.
- Historial corto.

También guarda la cifra anterior para ver la evolución, y puedes marcar favoritos. Si Binance publica una API oficial, se integra en una fase futura.

**Implementado en Eintes Robot 2.6** (pestaña **Traders**, archivo `traders.js`):

- Lista propia de hasta **10 traders**, ordenada por puntaje (los favoritos ★ van arriba).
- Etiquetas: **SÓLIDO** (70+), **ACEPTABLE** (50–69), **RIESGOSO** (<50).
- Cada actualización guarda una foto (hasta 24) y muestra ▲▼ frente a la anterior.
- Los 3 mejores aparecen en **Inicio**.
- Respaldo copiable para pasar la lista a otro teléfono (los datos viven solo en el teléfono).

---

## 6. Pruebas (Fase 8)

```bash
node test/engine.test.mjs    # indicadores, ausencia de "mirar el futuro", niveles SL/TP, backtest, riesgo
node test/scanner.test.mjs   # escáner completo con un Binance simulado
```

Recomendación antes de confiar en las señales:

1. Ejecuta backtests en 5–10 pares y en 1h y 4h.
2. Deja correr el escáner **4–6 semanas** sin operar y revisa el *Historial*.
3. Solo con 30 o más señales cerradas y un resultado medio positivo en R, considera operar con montos pequeños.

## 7. Seguridad

- La versión 1 no usa claves API.
- Si en el futuro se conecta tu cuenta:
  - Usa una clave **solo de lectura**, sin retiros y con IP restringida.
  - Guárdala en *Secrets* de GitHub, nunca en el código.
  - Toda orden requerirá tu confirmación expresa.

## 8. Próximas fases sugeridas

- Notificaciones push nativas (Web Push), además de Telegram.
- Ajuste de parámetros por moneda según el backtest.
- Conexión de solo lectura a tu cuenta para ver saldos reales.
