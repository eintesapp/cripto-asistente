@echo off
chcp 65001 >nul
title Evaluacion v2
cd /d "%~dp0"
echo.
echo  Evaluacion v2: estrategias distintas con datos reales (1 a 5 anos). Puede tardar unos minutos.
echo.
node evaluar-v2.mjs
if exist resultado-v2.html start "" resultado-v2.html
echo.
pause
