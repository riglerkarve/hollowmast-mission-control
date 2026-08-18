# owner-tasks.ps1 - every terminal step waiting on the owner, run in one pass.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\owner-tasks.ps1
#       runs every step it CAN, skips the rest with a reason, prints a summary
#
#   ... -File tools\owner-tasks.ps1 -Step 3          just one step
#   ... -File tools\owner-tasks.ps1 -List            show them without running anything
#   ... -File tools\owner-tasks.ps1 -PayPalCsv "C:\path\Download.CSV"
#   ... -File tools\owner-tasks.ps1 -Rotate          include the disruptive password rotation
#
# Standing instruction, 18 Aug 2026: commands meant for the owner are PowerShell, not bash. My
# own tools run Git Bash, so bash syntax works for me and fails at their prompt - "curl -s -u"
# produced "the parameter name 'u' is ambiguous", a baffling error about a command they had
# every reason to think was right.
#
# THREE OUTCOMES, NEVER TWO. Every step reports DONE, SKIPPED or FAILED, and the summary keeps
# them apart. A step that could not run is not a step that had nothing to do, and a run where
# everything was skipped must not read like a clean sweep - which is what a bare "finished"
# line would say.
#
# PURE ASCII. PS 5.1 reads a .ps1 as ANSI when there is no BOM, so a single en dash inside a
# quoted string breaks the parse and the script exits 1 having logged nothing at all. No
# dashes, no arrows, no curly quotes. 5.1 also has no "&&", no ternary and no "??"; chain with
# "if ($?)".

[CmdletBinding()]
param(
    [int]$Step = 0,
    [switch]$List,
    [switch]$Rotate,
    [string]$PayPalCsv = ""
)

$ErrorActionPreference = "Continue"
$MC   = "C:\Users\jcwhi\Claude Outputs\mission-control"
$SURV = "C:\Users\jcwhi\Claude Outputs\Survive"

$script:Results = @()

function Note($m) { Write-Host ("      " + $m) }
function Record($n, $name, $status, $why) {
    $script:Results += [pscustomobject]@{ N = $n; Name = $name; Status = $status; Why = $why }
    Write-Host ("      " + $status + "  " + $why)
}
function Head($n, $title) {
    Write-Host ""
    Write-Host ("  [" + $n + "] " + $title)
}

# ---- shared: push a repo and PROVE the remote moved ---------------------------------------
# Verifies by comparing ls-remote against local HEAD. "git push" exits 0 and moves nothing when
# HEAD is on another branch, and that has caught this workspace twice.
function Push-AndVerify($n, $name, $dir) {
    Set-Location $dir
    $remotes = git remote
    if (-not $remotes) {
        Record $n $name "SKIPPED" "no remote configured yet - create the private repo first"
        return
    }
    $dirty = git status --porcelain
    if ($dirty) {
        $count = ($dirty -split "`n" | Where-Object { $_ }).Count
        Note ($count.ToString() + " uncommitted file(s); other sessions share this checkout, so some may not be yours")
    }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $local  = (git rev-parse HEAD).Trim()
    Note ("branch " + $branch + ", local " + $local.Substring(0,8))

    git push -u origin $branch 2>&1 | ForEach-Object { Note $_ }

    $line = git ls-remote origin $branch
    if (-not $line) {
        Record $n $name "FAILED" "the remote has no branch $branch - the push moved nothing"
        return
    }
    $remote = ($line -split "\s+")[0]
    if ($remote -eq $local) {
        Record $n $name "DONE" ("remote verified at " + $remote.Substring(0,8))
    } else {
        Record $n $name "FAILED" ("remote is " + $remote.Substring(0,8) + " but local is " + $local.Substring(0,8))
    }
}

function Step1 {
    Head 1 "Push Mission Control to its private remote"
    Push-AndVerify 1 "Mission Control push" $MC
}

function Step2 {
    Head 2 "Push HOLLOWMAST"
    # Pages serves what is committed under site/, so a push carrying only src/ moves nothing a
    # browser will ever download. This caught the owner once: the push verified correctly
    # against ls-remote and was telling the truth, while the live game was still the previous
    # build, because site/play/index.html had been rebuilt on disk and never committed.
    # Checked here rather than left to be discovered on the live site.
    Set-Location $SURV
    $siteDirty = git status --porcelain site/
    if ($siteDirty) {
        Note "site/ has uncommitted build output - a push would NOT deploy it:"
        $siteDirty -split "`n" | Where-Object { $_ } | ForEach-Object { Note ("    " + $_) }
        Note "run: bash site-build/build-site.sh, then commit site/ before pushing"
    }
    Push-AndVerify 2 "HOLLOWMAST push" $SURV
}

function Step3 {
    Head 3 "Ship HOLLOWMAST to itch with butler"
    $key = Join-Path $SURV "data\itch-api-key.txt"
    if (-not (Test-Path $key)) {
        Record 3 "itch deploy" "SKIPPED" "no API key at data\itch-api-key.txt - make one at itch.io/user/settings/api-keys"
        return
    }
    Set-Location $SURV
    bash tools/deploy-itch.sh 2>&1 | ForEach-Object { Note $_ }
    if ($?) { Record 3 "itch deploy" "DONE" "butler reported the packed build is live" }
    else    { Record 3 "itch deploy" "FAILED" "deploy-itch.sh did not verify - read its output above" }
}

function Step4 {
    Head 4 "Import the PayPal statement, then reconcile it"
    if (-not $PayPalCsv) {
        Record 4 "PayPal import" "SKIPPED" "no CSV given - re-run with -PayPalCsv 'C:\path\Download.CSV'"
        return
    }
    if (-not (Test-Path $PayPalCsv)) {
        Record 4 "PayPal import" "FAILED" ("no such file: " + $PayPalCsv)
        return
    }
    Set-Location $MC
    Note "dry run first, nothing written:"
    node tools/import-paypal.cjs "$PayPalCsv" --account paypal --label "PayPal" --kind personal --dry 2>&1 | ForEach-Object { Note $_ }
    node tools/import-paypal.cjs "$PayPalCsv" --account paypal --label "PayPal" --kind personal 2>&1 | ForEach-Object { Note $_ }
    if (-not $?) { Record 4 "PayPal import" "FAILED" "the importer refused - read its reason above"; return }
    Note "matching bank PAYPAL credits against PayPal withdrawals:"
    node tools/reconcile-paypal.cjs 2>&1 | ForEach-Object { Note $_ }
    Record 4 "PayPal import" "DONE" "imported and reconciled - reconcile is report-only until you add --apply"
}

function Step5 {
    Head 5 "Save the Honeygain API token"
    $f = Join-Path $MC "data\honeygain-token.txt"
    if (Test-Path $f) {
        Set-Location $MC
        node tools/fetch-honeygain.cjs 2>&1 | ForEach-Object { Note $_ }
        if ($?) { Record 5 "Honeygain" "DONE" "token worked and earnings were read" }
        else    { Record 5 "Honeygain" "FAILED" "the token is present but did not work - it may have expired" }
        return
    }
    Record 5 "Honeygain" "SKIPPED" "no token yet - log in, DevTools, Network, copy the Authorization value"
    Note ("then: Read-Host 'token' | Set-Content -Encoding ascii '" + $f + "'")
}

function Step6 {
    Head 6 "Rotate the dash password"
    if (-not $Rotate) {
        Record 6 "Rotate password" "SKIPPED" "disruptive and interactive - re-run with -Rotate when ready"
        return
    }
    Set-Location $SURV
    Note "wrangler will prompt for the new value:"
    npx wrangler secret put DASH_PASSWORD
    if ($?) {
        Record 6 "Rotate password" "DONE" "rotated at Cloudflare"
        Note ("now update the local copy: Read-Host 'new' | Set-Content -Encoding ascii '" + (Join-Path $MC "data\dash-password.txt") + "'")
    } else {
        Record 6 "Rotate password" "FAILED" "wrangler did not complete"
    }
}

$steps = @(
    @{ N = 1; Title = "Push Mission Control to its private remote"; Fn = { Step1 } },
    @{ N = 2; Title = "Push HOLLOWMAST";                            Fn = { Step2 } },
    @{ N = 3; Title = "Ship HOLLOWMAST to itch with butler";        Fn = { Step3 } },
    @{ N = 4; Title = "Import the PayPal statement";                Fn = { Step4 } },
    @{ N = 5; Title = "Save the Honeygain API token";               Fn = { Step5 } },
    @{ N = 6; Title = "Rotate the dash password";                   Fn = { Step6 } }
)

if ($List) {
    Write-Host ""
    Write-Host "  Steps (run with no arguments to do all of them):"
    foreach ($s in $steps) { Write-Host ("    [" + $s.N + "] " + $s.Title) }
    Write-Host ""
    Write-Host "  Browser steps I cannot do - accounts and identity are yours:"
    Write-Host "    - empty PRIVATE repo at github.com/new named mission-control"
    Write-Host "    - itch API key at itch.io/user/settings/api-keys"
    Write-Host "    - PayPal activity exported as CSV"
    return
}

$start = Get-Location
if ($Step -gt 0) {
    $one = $steps | Where-Object { $_.N -eq $Step }
    if (-not $one) { Write-Host ("  no such step: " + $Step); Set-Location $start; return }
    & $one.Fn
} else {
    Write-Host ""
    Write-Host "  Running every step that can run. Ones that cannot will say why."
    foreach ($s in $steps) { & $s.Fn }
}
Set-Location $start

# ---- the summary, which keeps the three outcomes apart -------------------------------------
Write-Host ""
Write-Host "  ----------------------------------------------------------------"
$done    = @($script:Results | Where-Object { $_.Status -eq "DONE" })
$skipped = @($script:Results | Where-Object { $_.Status -eq "SKIPPED" })
$failed  = @($script:Results | Where-Object { $_.Status -eq "FAILED" })

foreach ($r in $script:Results) {
    Write-Host ("  " + $r.Status.PadRight(8) + "[" + $r.N + "] " + $r.Name)
}
Write-Host ""
Write-Host ("  done " + $done.Count + ", skipped " + $skipped.Count + ", failed " + $failed.Count)

if ($skipped.Count -gt 0) {
    Write-Host ""
    Write-Host "  Skipped is NOT finished. Each of these is waiting on something:"
    foreach ($r in $skipped) { Write-Host ("    [" + $r.N + "] " + $r.Why) }
}
if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "  Failed - these tried and did not succeed:"
    foreach ($r in $failed) { Write-Host ("    [" + $r.N + "] " + $r.Why) }
    exit 1
}
