# ============================================================================
#  launch_hidden.ps1  -  Start server.js in a detached, hidden process.
#  Called by start_background.bat. Works on Win7 PowerShell 2.0.
#  Pure ASCII on purpose.
#  Params:
#    -Server  full path to server.js
#    -LogFile full path to the log file (stdout+stderr appended here)
# ============================================================================
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$LogFile
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$worker = Join-Path $here '_hidden_worker.cmd'

$logDir = Split-Path -Parent $LogFile
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }

# Pass paths via environment variables. This way cmd /c receives exactly ONE
# quoted argument (the worker path), sidestepping Win7 cmd /c quote bugs.
$env:HIDDEN_SRV = $Server
$env:HIDDEN_LOG = $LogFile
if (-not $env:NODEEXE) { $env:NODEEXE = 'node' }

Add-Content -Path $LogFile -Value "===== background start: $(Get-Date) =====" -Encoding UTF8

# WindowStyle Hidden = no black window. Start-Process detaches from the
# launching console, so closing the .bat window will NOT stop the server.
$p = Start-Process -FilePath $env:COMSPEC -ArgumentList @('/c', ('"' + $worker + '"')) -WindowStyle Hidden -PassThru

Write-Output ("STARTED_PID=" + $p.Id)
