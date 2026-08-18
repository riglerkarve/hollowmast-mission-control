# owner-tasks.ps1 - every terminal step currently waiting on the owner, in one place.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\owner-tasks.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\owner-tasks.ps1 -Step 3
#
# Standing instruction, 18 Aug 2026: commands meant for the owner are PowerShell, not bash.
# My own tools run Git Bash, so bash syntax works for me and fails at their prompt - "curl -s
# -u" produced "the parameter name 'u' is ambiguous", which is a baffling error about a
# command they had every reason to think was right.
#
# PURE ASCII, deliberately. Windows PowerShell 5.1 reads a .ps1 as ANSI when there is no BOM,
# so a single en dash inside a quoted string breaks the parse and the script exits 1 having
# logged nothing. No dashes, no arrows, no curly quotes anywhere in this file. 5.1 also has no
# "&&", no ternary and no "??"; chaining is done with "if ($?)".
#
# EVERY STEP CHECKS ITS OWN PRECONDITION and says what it is about to do before doing it. A
# step that cannot run says why, and says it in a way that cannot be mistaken for "nothing to
# do" - the difference this whole workspace keeps being caught by.

[CmdletBinding()]
param([int]$Step = 0)

$ErrorActionPreference = "Continue"
$MC   = "C:\Users\jcwhi\Claude Outputs\mission-control"
$SURV = "C:\Users\jcwhi\Claude Outputs\Survive"
$PP   = "C:\Users\jcwhi\Claude Outputs\income-portfolio"

function Head($n, $title, $why) {
    Write-Host ""
    Write-Host ("  [" + $n + "] " + $title)
    Write-Host ("      " + $why)
}
function Ok($m)   { Write-Host ("      OK    " + $m) }
function Warn($m) { Write-Host ("      NOTE  " + $m) }
function Bad($m)  { Write-Host ("      STOP  " + $m) }

function Show-Menu {
    Write-Host ""
    Write-Host "  Waiting on you. Run one with -Step N, or read and pick."
    Head 1 "Push Mission Control to its new private remote" "101+ commits exist on one disk. History already scanned: no secrets in 853 blobs."
    Head 2 "Push HOLLOWMAST" "The consent wall removal and the F8 bug box are built but not live."
    Head 3 "Ship HOLLOWMAST to itch with butler" "Needs an API key first. itch is serving an older build than dist."
    Head 4 "Import the PayPal statement" "Settles what SerpClix actually paid and which 54 bank rows were never refunds."
    Head 5 "Rotate the dash password" "It appeared in a screenshot in the session transcript."
    Head 6 "Save the Honeygain API token" "Replaces the daily-screenshot plan with something that needs nothing from you."
    Write-Host ""
    Write-Host "  Browser steps I cannot do (accounts and identity are yours):"
    Write-Host "    - create the empty PRIVATE repo at github.com/new, named mission-control"
    Write-Host "    - create an itch API key at itch.io/user/settings/api-keys"
    Write-Host "    - export PayPal activity as CSV"
    Write-Host ""
}

function Step1 {
    Head 1 "Push Mission Control to its new private remote" "Verifies the effect, not the exit code."
    Set-Location $MC
    $remotes = git remote
    if (-not $remotes) {
        Bad "No remote is configured yet."
        Write-Host "      Create an EMPTY PRIVATE repo named mission-control at github.com/new,"
        Write-Host "      tick nothing (no README, no .gitignore, no licence), then run:"
        Write-Host "        git remote add origin https://github.com/riglerkarve/mission-control.git"
        Write-Host "      and run this step again."
        return
    }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $local  = (git rev-parse HEAD).Trim()
    Ok ("branch " + $branch + ", local HEAD " + $local.Substring(0,8))
    git push -u origin $branch
    $line = git ls-remote origin $branch
    if ($line) {
        $remote = ($line -split "\s+")[0]
        if ($remote -eq $local) { Ok ("VERIFIED: the remote holds " + $remote.Substring(0,8)) }
        else { Bad ("remote is at " + $remote.Substring(0,8) + " but local is " + $local.Substring(0,8)) }
    } else {
        Bad "The remote has no such branch. The push reported success and moved nothing."
    }
}

function Step2 {
    Head 2 "Push HOLLOWMAST" "The site build is staged locally; nothing is live until this runs."
    Set-Location $SURV
    $dirty = git status --porcelain
    if ($dirty) {
        Warn "Working tree is not clean. Other sessions share this checkout, so these may not be yours:"
        $dirty -split "`n" | Where-Object { $_ } | ForEach-Object { Write-Host ("        " + $_) }
        Write-Host "      Commit only what is yours with: git commit --only <paths> -m ..."
    }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $local  = (git rev-parse HEAD).Trim()
    git push origin $branch
    $line = git ls-remote origin $branch
    if ($line) {
        $remote = ($line -split "\s+")[0]
        if ($remote -eq $local) { Ok ("VERIFIED: remote matches local at " + $local.Substring(0,8)) }
        else { Bad "remote does not match local HEAD" }
    }
}

function Step3 {
    Head 3 "Ship HOLLOWMAST to itch with butler" "Builds, packs, pushes, then asks itch what it is serving."
    Set-Location $SURV
    $key = Join-Path $SURV "data\itch-api-key.txt"
    if (-not (Test-Path $key)) {
        Bad "No API key at data\itch-api-key.txt"
        Write-Host "      Create one at https://itch.io/user/settings/api-keys, then:"
        Write-Host ("        Read-Host 'itch key' | Set-Content -Encoding ascii '" + $key + "'")
        Write-Host "      It is already gitignored. This is 'cannot look', not 'nothing to upload'."
        return
    }
    Ok "key present"
    bash tools/deploy-itch.sh
}

function Step4 {
    Head 4 "Import the PayPal statement" "Names who actually paid you, which the bank cannot."
    $csv = Read-Host "      Full path to the PayPal CSV (blank to cancel)"
    if (-not $csv) { Warn "cancelled"; return }
    if (-not (Test-Path $csv)) { Bad ("no such file: " + $csv); return }
    Set-Location $MC
    Write-Host "      Dry run first - nothing is written:"
    node tools/import-paypal.cjs "$csv" --account paypal --label "PayPal" --kind personal --dry
    $go = Read-Host "      Import for real? (y/N)"
    if ($go -eq "y") {
        node tools/import-paypal.cjs "$csv" --account paypal --label "PayPal" --kind personal
        Write-Host "      Now matching bank PAYPAL credits against PayPal withdrawals:"
        node tools/reconcile-paypal.cjs
        Write-Host "      Report only. Add --apply to recategorise the matched ones."
    } else { Warn "not imported" }
}

function Step5 {
    Head 5 "Rotate the dash password" "It appeared in a screenshot, so it is in the session transcript."
    Set-Location $SURV
    Write-Host "      This will prompt you for a new value and store it as a Worker secret."
    npx wrangler secret put DASH_PASSWORD
    if ($?) {
        Ok "rotated. Now update the local copy so the reader keeps working:"
        Write-Host ("        Read-Host 'new password' | Set-Content -Encoding ascii '" + (Join-Path $MC "data\dash-password.txt") + "'")
    }
}

function Step6 {
    Head 6 "Save the Honeygain API token" "Then earnings arrive with no screenshot and no obligation."
    $f = Join-Path $MC "data\honeygain-token.txt"
    Write-Host "      Log in at dashboard.honeygain.com, open DevTools, Network tab, click any"
    Write-Host "      request, and copy the Authorization value (without the word Bearer)."
    $t = Read-Host "      Paste it here (blank to cancel)"
    if (-not $t) { Warn "cancelled"; return }
    Set-Content -Path $f -Value $t -Encoding ascii
    Ok ("saved to " + $f + " (already gitignored)")
    Set-Location $MC
    node tools/fetch-honeygain.cjs
}

switch ($Step) {
    1 { Step1 }
    2 { Step2 }
    3 { Step3 }
    4 { Step4 }
    5 { Step5 }
    6 { Step6 }
    default { Show-Menu }
}
