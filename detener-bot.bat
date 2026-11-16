@echo off
chcp 65001 >nul
title Eintes Robot - Detener
echo.
echo  Deteniendo el bot y el inicio automatico (hasta el proximo inicio de sesion)...
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'Eintes Robot' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -and $_.CommandLine -match 'bot\.mjs') -or ($_.Name -eq 'powershell.exe' -and $_.CommandLine -match 'iniciar-bot-automatico') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo  Listo. El bot esta detenido.
echo  Se volvera a encender solo la proxima vez que inicies sesion en Windows.
echo  Para encenderlo ahora: Programador de tareas ^> Eintes Robot ^> Ejecutar.
echo.
pause
