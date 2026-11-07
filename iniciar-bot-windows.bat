@echo off
chcp 65001 >nul
title Cripto Senales - Bot
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Falta instalar Node.js. Descargalo desde https://nodejs.org y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

if exist ".env" goto iniciar

echo.
echo  ===== Configuracion inicial =====
echo  Las claves se guardan SOLO en este computador, en el archivo .env de esta carpeta.
echo  Pegalas con clic derecho y presiona Enter despues de cada una.
echo.
set MODE=testnet
set /p MODE=Modo: escribe testnet (dinero ficticio) o real (dinero real) [testnet]: 
if /i "%MODE%"=="real" goto confirmar
set MODE=testnet
goto claves

:confirmar
set MODE=real
echo.
echo  ATENCION: en modo REAL el bot opera con tu dinero cuando tocas "Si" en Telegram.
echo  Usa una clave API con permisos de Lectura y Spot Trading. NUNCA actives retiros.
set /p OK=Escribe SI en mayusculas para confirmar: 
if /i not "%OK%"=="SI" (
  echo  No confirmado. Se usara testnet.
  set MODE=testnet
)

:claves
echo.
set /p KEY=Binance %MODE% - API Key: 
set /p SECRET=Binance %MODE% - Secret Key: 
set /p TGT=Telegram - Token del bot: 
set /p TGC=Telegram - Tu chat ID: 
(
  echo BINANCE_MODE=%MODE%
  echo BINANCE_API_KEY=%KEY%
  echo BINANCE_API_SECRET=%SECRET%
  echo TELEGRAM_BOT_TOKEN=%TGT%
  echo TELEGRAM_CHAT_ID=%TGC%
) > ".env"
cls
echo.
echo  Configuracion guardada en modo %MODE%.

:iniciar
echo.
echo  Iniciando el bot... Deberias recibir "Bot iniciado" en Telegram.
echo  NO cierres esta ventana (puedes minimizarla).
echo  Para cambiar de modo o de claves: cierra el bot, escribe  del .env  y vuelve a abrir este archivo.
echo.
node --env-file=.env bot.mjs
echo.
echo  El bot se detuvo. Revisa el mensaje de arriba.
pause
