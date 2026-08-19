# owner-setup-stats-codex.ps1
#
# The three things only you can do, and a check for each that proves it worked.
#
#   powershell -ExecutionPolicy Bypass -File tools\owner-setup-stats-codex.ps1
#
# It CHANGES NOTHING on its own. It reports what is present, tells you exactly what is
# missing, and re-checks. Run it as many times as you like.
#
# Written after the quiz of 19 Aug 2026, where you chose:
#   - HOLLOWMAST stats from BOTH Google Analytics and the game telemetry endpoint
#   - Codex as an independent reviewer
#   - the safety module governing it, on your subscription rather than API billing
#
# ASCII only. PowerShell 5.1 reads a BOM-less file as ANSI, so a smart quote or a long dash
# anywhere in here breaks the parse and the whole thing exits having logged nothing.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
$done = 0
$todo = 0

function Head($n, $t) {
  Write-Host ''
  Write-Host ("  {0}. {1}" -f $n, $t)
  Write-Host ('  ' + ('-' * ($t.Length + 3)))
}
function Ok($m)   { Write-Host ("      DONE    " + $m) ; $script:done = $script:done + 1 }
function Need($m) { Write-Host ("      TO DO   " + $m) ; $script:todo = $script:todo + 1 }
function Info($m) { Write-Host ("              " + $m) }

Write-Host ''
Write-Host '  HOLLOWMAST stats, and Codex as a reviewer'
Write-Host '  Nothing here is changed by this script. It checks, and it tells you.'

# ---------------------------------------------------------------- 1. game telemetry
Head 1 'Game telemetry - reports.hollowmast.com'
$keyFile = Join-Path $dataDir 'reports-admin-key.txt'
if (Test-Path $keyFile) {
  Ok ("a key file exists at data\reports-admin-key.txt")
  Info 'Testing it against the live endpoint...'
  $key = (Get-Content $keyFile -Raw).Trim()
  $code = (curl.exe -s -o NUL -w "%{http_code}" --max-time 20 ("https://reports.hollowmast.com/summary?key=" + $key))
  if ($code -eq '200') {
    Info 'The endpoint answered 200. Mission Control can read play sessions and median playtime.'
  } else {
    Info ("The endpoint answered " + $code + ", not 200. The key in that file is wrong or has been rotated.")
    Info 'A 403 means the key is not accepted. Get the current one from the Cloudflare'
    Info 'dashboard: Workers and Pages -> hollowmast-reports -> Settings -> Variables.'
  }
} else {
  Need 'no key file yet'
  Info 'The endpoint is live and answers 403 without a key - I checked. The key exists only'
  Info 'on the Worker, so it has to come from you.'
  Info ''
  Info '  a) Cloudflare dashboard -> Workers and Pages -> hollowmast-reports'
  Info '  b) Settings -> Variables and Secrets -> reveal ADMIN_KEY'
  Info '  c) Save it as the ONLY line in: data\reports-admin-key.txt'
  Info ''
  Info 'That path is already in .gitignore and I proved the ignore works with a decoy'
  Info 'before writing this. I never print the key, including in an error.'
}

# ---------------------------------------------------------------- 2. Google Analytics
Head 2 'Website stats - Google Analytics'
$saFile = Join-Path $dataDir 'ga-service-account.json'
if (Test-Path $saFile) {
  Ok 'a service account file exists at data\ga-service-account.json'
  Info 'Mission Control will use it to read property 550647304.'
} else {
  Need 'no read access yet'
  Info 'Your tag G-CYZR1KMHMN is LIVE on hollowmast.com and collecting right now - I checked'
  Info 'the served HTML. The data exists. Only permission to READ it is missing.'
  Info ''
  Info 'The service-account route, which does not expire and needs no consent screen:'
  Info '  a) console.cloud.google.com -> IAM and Admin -> Service Accounts -> Create'
  Info '  b) Create a JSON key for it, save as data\ga-service-account.json'
  Info '  c) In Google Analytics -> Admin -> Property Access Management (property 550647304)'
  Info '     add that service account email as a VIEWER'
  Info '  d) Enable the Google Analytics Data API in that Cloud project'
  Info ''
  Info 'I cannot do any of this: it is account creation and a consent step, and I do not'
  Info 'do either. Opening the pages for you is all I can offer.'
}
Info ''
Info 'WORTH KNOWING BEFORE YOU READ ANY GA NUMBER: the tag fires only after cookie consent,'
Info 'and your own IP is filtered out. So every GA figure is a FLOOR, never a total. The'
Info 'panel will say so permanently rather than in small print.'

# ---------------------------------------------------------------- 3. Codex
Head 3 'Codex as an independent reviewer'
$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  Ok ("codex is on PATH at " + $codex.Source)
  Info 'Checking whether it is signed in...'
  $v = (& codex --version 2>&1 | Out-String).Trim()
  Info ("version: " + $v)
} else {
  Need 'codex is not installed'
  Info 'Confirmed: not on PATH, and not a global npm package on this machine.'
  Info ''
  Info 'You said you will use a SUBSCRIPTION rather than API billing. That matters: it means'
  Info 'the CLI signs in with your ChatGPT account and there is no API key for me to hold,'
  Info 'and no per-call charge. The limit becomes a rate limit rather than a bill.'
  Info ''
  Info '  a) Install the Codex CLI (npm install -g @openai/codex, or the current package -'
  Info '     check the official docs rather than trusting this line, which may age)'
  Info '  b) Run: codex login    and sign in with the account that holds the subscription'
  Info '  c) Re-run this script - it will confirm'
  Info ''
  Info 'I will not install or sign in to anything on your behalf.'
}

# ---------------------------------------------------------------- 4. the spend guard
Head 4 'The safety guard'
Write-Host '      This one is a decision, not an install.'
Info 'server/routes/safety.js fails closed: both ceilings are 0 and the allowlist is empty,'
Info 'so it refuses everything until you set a limit deliberately. That is not a bug - it was'
Info 'built before anything could spend, precisely so the first thing that can is stopped by'
Info 'default. Codex will be its first real caller.'
Info ''
Info 'On a subscription there is no pound figure to cap, so the ceiling counts INVOCATIONS.'
Info 'Set it in the dashboard: Safety panel. Until you do, reviews will be refused and will'
Info 'say so - they will not silently not happen.'

Write-Host ''
Write-Host ("  {0} done, {1} waiting on you." -f $done, $todo)
Write-Host '  Re-run this script after each one. It re-checks rather than trusting a tick.'
Write-Host ''
