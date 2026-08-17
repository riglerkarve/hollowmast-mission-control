# Launched by the "MissionControl-Server" scheduled task at logon, and by the
# watchdog when it needs to bring the server back.
#
# Redirects server output to a daily log file so a crash is visible instead of silent.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI unless the file
# has a BOM, so a UTF-8 em-dash inside a double-quoted string becomes mojibake that the
# parser reads as an early string terminator. Cost 17 Aug 2026: the task exited 1 with
# no log output at all, which looked exactly like a permissions problem.
#
# MUST BE IDEMPOTENT. Verified 17 Aug 2026: "schtasks /end" reports
#   "SUCCESS: ... has been terminated successfully"
# and sets the task to Ready while the node child KEEPS RUNNING and keeps port 3000.
# Task Scheduler kills the PowerShell wrapper; the node process it launched is not in a
# job object that dies with it, so it is orphaned. A /run after that starts a second
# node which cannot bind, exits, and leaves you believing you restarted the service.
#
# So this script frees the port itself before starting.

$root = Split-Path -Parent $PSScriptRoot
$port = 3000

$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir ("server-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'), $msg
  Add-Content -Path $logFile -Value $line -Encoding utf8
}

# --- free the port, but only from our own kind of process -------------------------
$holders = @()
try {
  $holders = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop |
               Select-Object -ExpandProperty OwningProcess -Unique)
} catch {
  $holders = @()   # nothing listening
}

foreach ($holderId in $holders) {
  $proc = Get-Process -Id $holderId -ErrorAction SilentlyContinue
  if (-not $proc) { continue }

  if ($proc.ProcessName -ne 'node') {
    # Refuse rather than guess. Killing an unrelated process to free a port is a far
    # worse outcome than not starting.
    Write-Log ("ABORT: port {0} held by {1} (pid {2}), not node. Not touching it." -f $port, $proc.ProcessName, $holderId)
    exit 3
  }

  Write-Log ("port {0} held by orphaned node pid {1}, stopping it" -f $port, $holderId)
  Stop-Process -Id $holderId -Force -ErrorAction SilentlyContinue
}

# Confirm the port actually came free. A kill that did not take must not look like a start.
for ($i = 0; $i -lt 10; $i++) {
  $still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if ($still.Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
}
$still = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($still.Count -gt 0) {
  Write-Log ("ABORT: port {0} still held after stop attempt" -f $port)
  exit 4
}

# --- start ------------------------------------------------------------------------
$node = (Get-Command node).Source
Write-Log "starting server"

Set-Location $root
& $node "server/index.js" 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8

Write-Log ("server process exited with {0}" -f $LASTEXITCODE)
