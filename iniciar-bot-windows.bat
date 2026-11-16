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
echo  ===== Configuracion =====
echo  Modos:
echo    papel   = dinero VIRTUAL con precios REALES (recomendado para probar la estrategia)
echo    testnet = dinero ficticio en el Testnet de Binance (solo para probar que las ordenes funcionan)
echo    real    = tu dinero real
echo.
set MODE=papel
set /p MODE=Modo [papel]: 
if /i "%MODE%"=="real" goto confirmar
if /i "%MODE%"=="testnet" (set MODE=testnet& goto claves)
set MODE=papel
set KEY=
set SECRET=
goto telegram

:confirmar
set MODE=real
echo.
echo  ATENCION: en modo REAL el bot opera con tu dinero cuando tocas "Si" en Telegram.
echo  Usa una clave API con permisos de Lectura y Spot Trading. NUNCA actives retiros.
set /p OK=Escribe SI para confirmar: 
if /i not "%OK%"=="SI" (
  echo  No confirmado. Se usara modo papel.
  set MODE=papel
  set KEY=
  set SECRET=
  goto telegram
)

:claves
echo.
echo  Pega las claves con clic derecho y presiona Enter despues de cada una.
set /p KEY=Binance %MODE% - API Key: 
set /p SECRET=Binance %MODE% - Secret Key: 

:telegram
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
rem Nunca dos bots a la vez: revisar si ya hay uno corriendo o si el inicio automatico esta activo
powershell -NoProfile -Command "if ((Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'bot\.mjs' }) -or ((Get-ScheduledTask -TaskName 'Eintes Robot' -ErrorAction SilentlyContinue).State -eq 'Running')) { exit 3 }"
if errorlevel 3 (
  echo.
  echo  YA HAY UN BOT CORRIENDO ^(o el inicio automatico esta activo^).
  echo  No se abrira otro para evitar compras dobles.
  echo  Para detener el automatico: Programador de tareas ^> Eintes Robot ^> Finalizar.
  echo.
  pause
  exit /b 0
)
echo.
echo  Iniciando el bot... Deberias recibir "Bot iniciado" en Telegram.
echo  NO cierres esta ventana (puedes minimizarla).
echo  Para cambiar de modo o de claves: cierra el bot, escribe  del .env  y vuelve a abrir este archivo.
echo.
node --env-file=.env bot.mjs
echo.
echo  El bot se detuvo. Revisa el mensaje de arriba.
pause
