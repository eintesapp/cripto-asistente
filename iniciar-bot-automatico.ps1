# Eintes Robot - lanzador automatico (Windows)
# Lo abre el Programador de tareas al iniciar sesion. Mantiene el bot encendido:
#  - Si el bot se cae o se cierra, lo vuelve a abrir (espera 1 min; si se cae seguido, espera mas).
#  - Nunca abre un segundo bot si ya hay uno corriendo (evita compras dobles).
#  - Mientras corre, le pide a Windows que no se suspenda (la pantalla si puede apagarse).
# Registro: bot-log.txt en esta carpeta.

$ErrorActionPreference = 'Continue'
$carpeta = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $carpeta
$log = Join-Path $carpeta 'bot-log.txt'

function Escribir($texto) {
  $linea = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $texto
  Add-Content -Path $log -Value $linea -Encoding UTF8
}

function BotCorriendo {
  $procesos = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procesos) { if ($p.CommandLine -match 'bot\.mjs') { return $true } }
  return $false
}

# Un solo lanzador a la vez (candado del sistema)
$creado = $false
$candado = New-Object System.Threading.Mutex($true, 'Local\EintesRobotLanzador', [ref]$creado)
if (-not $creado) { exit 0 }

# Pedir a Windows que no se suspenda mientras este lanzador este abierto
Add-Type -Namespace Eintes -Name Energia -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
$ES_CONTINUOUS = [uint32]'0x80000000'; $ES_SYSTEM_REQUIRED = [uint32]'0x00000001'
[void][Eintes.Energia]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)

if (-not (Test-Path (Join-Path $carpeta '.env'))) {
  Escribir 'No existe .env. Abre primero iniciar-bot-windows.bat para configurar.'
  exit 1
}

# Recortar el registro si crece mucho (mas de 2 MB)
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 2MB)) { Move-Item $log ($log + '.anterior') -Force }

Escribir '=== Lanzador automatico iniciado ==='
$caidasSeguidas = 0
while ($true) {
  if (BotCorriendo) {
    # Hay un bot abierto a mano: no abrir otro, solo vigilar
    Start-Sleep -Seconds 60
    continue
  }
  Escribir 'Iniciando bot...'
  $inicio = Get-Date
  cmd /c "node --env-file=.env bot.mjs >> bot-log.txt 2>&1"
  $duracion = ((Get-Date) - $inicio).TotalMinutes
  Escribir ("El bot se detuvo (codigo {0}) despues de {1:N1} min." -f $LASTEXITCODE, $duracion)
  if ($duracion -lt 10) { $caidasSeguidas++ } else { $caidasSeguidas = 0 }
  # 1 min normalmente; si se cae seguido: 2, 4, 8... hasta 30 min (evita llenar Telegram de avisos)
  $espera = [Math]::Min(30, [Math]::Pow(2, [Math]::Max(0, $caidasSeguidas - 1)))
  Escribir ("Reinicio en {0} min." -f $espera)
  Start-Sleep -Seconds ([int]($espera * 60))
}
