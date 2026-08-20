# ollama-cloud-research.ps1 - launch Ollama Cloud via an agent CLI, for one bounded research task.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ollama-cloud-research.ps1 -Task "..."
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ollama-cloud-research.ps1 -TaskFile path\to\task.md
#
# OLLAMA-CLOUD.md is this tier's charter: research and project ideas for EXISTING tracks, never
# code, never a decision, never sensitive data. That charter said no dedicated wrapper existed
# yet; this is that wrapper, kept minimal.
#
# WHY ISOLATED, NOT THE LIVE REPO. The same agent mechanism (Qwen Code CLI) was bounded-tested on
# a local model the same evening this was written and produced plausible, well-commented code
# that threw on every real input. Cloud research has never been tested here at all. OLLAMA-CLOUD.md
# says outright "the standard this tier starts at: Zero", so this script does not hand an unproven
# agent+model combination write access to the live checkout on its first real runs. Output lands
# in an isolated scratch directory; promoting it into reference/ is a separate, human step.
#
# PURE ASCII. Windows PowerShell 5.1 reads a .ps1 as ANSI with no BOM; one smart quote or long
# dash breaks the parse silently and the script exits having logged nothing. No arrows, no en or
# em dashes, no curly quotes anywhere in this file.
#
# 5.1 has no "&&", no ternary, no "??" - chaining is done with "if ($LASTEXITCODE -eq 0) { ... }".
# Native commands are checked via $LASTEXITCODE, never $?, and stderr is never merged into the
# success stream with 2>&1 - both are documented traps in this workspace.

[CmdletBinding()]
param(
    [string]$Task = "",
    [string]$TaskFile = "",
    [string]$Model = "gpt-oss:20b-cloud",
    [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $Task -and -not $TaskFile) {
    Write-Host ""
    Write-Host "  usage: ollama-cloud-research.ps1 -Task ""<research question>"""
    Write-Host "         ollama-cloud-research.ps1 -TaskFile path\to\task.md"
    Write-Host ""
    Write-Host "  No default task is invented here. PLAN-OLLAMA-2026-08-20.md's own rule: inventing"
    Write-Host "  jobs to keep a model busy is exactly the surface-you-must-feed the workspace gate"
    Write-Host "  rejects. Supply a real question."
    Write-Host ""
    exit 2
}

if ($TaskFile) {
    if (-not (Test-Path $TaskFile)) {
        Write-Host ""
        Write-Host "  COULD NOT LOOK: no file at $TaskFile"
        exit 2
    }
    $Task = Get-Content $TaskFile -Raw
}

# ---- ollama itself, reachable before anything else is checked
Write-Host ""
Write-Host "  checking Ollama..."
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" -UseBasicParsing -TimeoutSec 5
    Write-Host "  Ollama is reachable"
} catch {
    Write-Host ""
    Write-Host "  COULD NOT LOOK: Ollama is not reachable at 127.0.0.1:11434."
    Write-Host "  Nothing was run. Start Ollama first."
    exit 2
}

# ---- qwen CLI, the agent this script drives. Not auto-installed here - that is a deliberate,
# ---- separate action (ollama launch qwen --yes --config --model ...), not a side effect of a
# ---- research run.
$qwenCmd = Get-Command qwen -ErrorAction SilentlyContinue
if (-not $qwenCmd) {
    Write-Host ""
    Write-Host "  COULD NOT LOOK: the 'qwen' command is not installed."
    Write-Host "  Install it deliberately first: ollama launch qwen --yes --config --model qwen3.5:4b"
    exit 2
}

# ---- docker, required for --sandbox. Started here if not running, because a research run should
# ---- not silently fall back to unsandboxed on an untested tier.
Write-Host ""
Write-Host "  checking Docker..."
docker info 2>$null 1>$null
$dockerUp = ($LASTEXITCODE -eq 0)

if (-not $dockerUp) {
    Write-Host "  Docker is not running. Starting Docker Desktop..."
    $dockerExe = "C:\Users\jcwhi\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Start-Process $dockerExe
    } else {
        Write-Host ""
        Write-Host "  COULD NOT LOOK: Docker Desktop.exe not found at the expected path."
        Write-Host "  Start Docker manually, then re-run."
        exit 2
    }
    $waited = 0
    while ((-not $dockerUp) -and ($waited -lt 180)) {
        Start-Sleep -Seconds 5
        $waited += 5
        docker info 2>$null 1>$null
        $dockerUp = ($LASTEXITCODE -eq 0)
    }
    if (-not $dockerUp) {
        Write-Host ""
        Write-Host "  Docker did not come up within 180s. Nothing was run."
        exit 1
    }
    Write-Host "  Docker is up, after $waited s"
} else {
    Write-Host "  Docker is already running"
}

# ---- the qwen sandbox reaches the host through host.docker.internal, not 127.0.0.1 - fixed once
# ---- already after a first sandboxed run failed with ECONNREFUSED. Ensured here rather than
# ---- assumed, since a future session or a fresh machine would hit the same failure.
$settingsPath = "$env:USERPROFILE\.qwen\settings.json"
if (Test-Path $settingsPath) {
    $raw = Get-Content $settingsPath -Raw
    if ($raw -match "127\.0\.0\.1:11434") {
        Write-Host ""
        Write-Host "  qwen settings point at 127.0.0.1, which the sandbox container cannot reach."
        Write-Host "  Rewriting to host.docker.internal (the same fix applied once already)."
        $fixed = $raw -replace "127\.0\.0\.1:11434", "host.docker.internal:11434"
        Set-Content -Path $settingsPath -Value $fixed -NoNewline
    }
}

# ---- isolated output location. Never the live repo on an unproven tier.
if (-not $OutDir) {
    $stamp = Get-Date -Format "yyyy-MM-dd-HHmmss"
    $OutDir = Join-Path $env:TEMP "ollama-cloud-research-$stamp"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Copy-Item (Join-Path $repo "OLLAMA-CLOUD.md") $OutDir -ErrorAction SilentlyContinue

$taskPath = Join-Path $OutDir "TASK.md"
$fullTask = $Task + "`n`n---`nYou are bound by OLLAMA-CLOUD.md, copied into this directory. " +
    "Read it first. Write your research to RESEARCH.md in this same directory. Do not write " +
    "any other file. Do not propose a new project; this is research for an existing track. " +
    "Prose only, no code."
Set-Content -Path $taskPath -Value $fullTask -NoNewline

Write-Host ""
Write-Host "  model   : $Model"
Write-Host "  out dir : $OutDir"
Write-Host ""
Write-Host "  running (sandboxed, this can take a while)..."
Write-Host ""

Push-Location $OutDir
try {
    qwen -p "Read TASK.md in this directory and do exactly what it says." --model $Model --sandbox -y -o text
    $ranOk = ($LASTEXITCODE -eq 0)
} finally {
    Pop-Location
}

$resultFile = Join-Path $OutDir "RESEARCH.md"
Write-Host ""
if (Test-Path $resultFile) {
    Write-Host "  WROTE: $resultFile"
    Write-Host "  Read it before anything else happens to it. Nothing here files it on the board"
    Write-Host "  or copies it into reference/ - OLLAMA-CLOUD.md is explicit that every output"
    Write-Host "  from this tier is a proposal a person reviews first."
} else {
    Write-Host "  NO RESEARCH.md WRITTEN. exec ran but produced no output file - report this as a"
    Write-Host "  finding, not as an empty result. Check $OutDir for anything it did write."
}
if (-not $ranOk) {
    Write-Host ""
    Write-Host "  qwen exited non-zero. Not evidence either way on its own - check what is"
    Write-Host "  actually in $OutDir before concluding anything."
}
