# push-to-remote.ps1 - give Mission Control its first git remote, and PROVE the push moved.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\push-to-remote.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\push-to-remote.ps1 -Url https://github.com/you/repo.git
#
# Backlog M64. Until tonight this repository had 101+ commits, no remote, no bundle and no
# mirror: every line of its history existed in exactly one place.
#
# WHY THIS VERIFIES INSTEAD OF TRUSTING THE EXIT CODE. "git push origin master" exits 0 and
# moves nothing if HEAD is on another branch, and this workspace has already been caught by
# that once. So the check is a comparison: the sha the remote reports must equal local HEAD.
# An exit code says a command ran. A hash says the work arrived.
#
# PURE ASCII, deliberately. Windows PowerShell 5.1 reads a .ps1 as ANSI when there is no BOM,
# so a single en dash inside a quoted string breaks the parse and the script exits 1 having
# logged nothing at all. No arrows, no dashes, no curly quotes in this file.
#
# Also note 5.1 has no "&&", no ternary and no "??". Chaining is done with "if ($?)".

[CmdletBinding()]
param(
    [string]$Url = "https://github.com/riglerkarve/mission-control.git",
    [string]$RemoteName = "origin"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host ""
Write-Host "  repository : $repo"
Write-Host "  remote url : $Url"

# ---- the branch is read, never assumed. This repo is on master, not main, and the commands
# ---- GitHub prints on a new empty repo assume main.
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$localSha = (git rev-parse HEAD).Trim()
$commits = (git rev-list --count HEAD).Trim()
Write-Host "  branch     : $branch"
Write-Host "  commits    : $commits"
Write-Host "  local HEAD : $localSha"

# ---- refuse to push a dirty tree. Several sessions share this checkout, so an uncommitted
# ---- file here is usually somebody else's work in progress and not mine to sweep along.
$dirty = git status --porcelain
if ($dirty) {
    Write-Host ""
    Write-Host "  The working tree is not clean. Uncommitted files:"
    $dirty -split "`n" | Where-Object { $_ } | ForEach-Object { Write-Host "    $_" }
    Write-Host ""
    Write-Host "  Not pushing. Uncommitted work is invisible to other sessions, and in a shared"
    Write-Host "  checkout it is usually theirs. Commit what is yours with:"
    Write-Host "    git commit --only <paths> -m ..."
    exit 1
}

# ---- secrets. A first push publishes the HISTORY, not just the working tree.
if (Test-Path (Join-Path $repo "tools\secrets-scan.cjs")) {
    Write-Host ""
    Write-Host "  Scanning every commit for live secret values before publishing anything..."
    node tools\secrets-scan.cjs --history
    if (-not $?) {
        Write-Host ""
        Write-Host "  The secret scan did NOT pass. Nothing was pushed."
        Write-Host "  Rotate the credential first: rewriting history does not un-leak what was fetched."
        exit 1
    }
}

# ---- the remote. Idempotent: re-running this must not fail on an existing remote, and must
# ---- not silently keep a stale url either.
$existing = git remote get-url $RemoteName 2>$null
if ($LASTEXITCODE -eq 0) {
    if ($existing.Trim() -eq $Url) {
        Write-Host ""
        Write-Host "  remote '$RemoteName' already points at this url"
    } else {
        Write-Host ""
        Write-Host "  remote '$RemoteName' pointed at $($existing.Trim())"
        Write-Host "  updating it to $Url"
        git remote set-url $RemoteName $Url
    }
} else {
    git remote add $RemoteName $Url
    Write-Host ""
    Write-Host "  remote '$RemoteName' added"
}

# ---- push
Write-Host ""
Write-Host "  Pushing $branch to $RemoteName. A credential prompt may appear."
git push -u $RemoteName $branch
$pushOk = $?

# ---- VERIFY THE EFFECT. This is the point of the script.
Write-Host ""
Write-Host "  Checking what the remote actually holds..."
$remoteLine = git ls-remote $RemoteName $branch
$remoteSha = ""
if ($remoteLine) { $remoteSha = ($remoteLine -split "\s+")[0] }

Write-Host "    local  : $localSha"
if ($remoteSha) {
    Write-Host "    remote : $remoteSha"
} else {
    Write-Host "    remote : (no such branch on the remote)"
}

if ($remoteSha -and ($remoteSha -eq $localSha)) {
    Write-Host ""
    Write-Host "  MATCH. All $commits commits are on the remote."
    Write-Host "  Mission Control's history now exists in more than one place."
    exit 0
}

Write-Host ""
Write-Host "  NOT VERIFIED. The remote does not hold local HEAD."
if ($pushOk) {
    Write-Host "  Note the push itself reported success, which is exactly the failure this"
    Write-Host "  check exists to catch. Do not treat the repository as backed up."
}
exit 1
