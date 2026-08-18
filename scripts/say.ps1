# Major Tom -- speak one line through Windows System.Speech. Backlog #22.
#
# PURE ASCII ONLY. PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a UTF-8 dash inside a
# quoted string breaks the parse and the task exits 1 having logged nothing.
#
# Verified 18 Aug 2026: System.Speech present, voices Microsoft Hazel Desktop and
# Microsoft Zira Desktop.
param(
  [Parameter(Mandatory=$true)][string]$Text,
  [string]$Voice = "",
  [int]$Rate = 0
)
try {
  Add-Type -AssemblyName System.Speech -ErrorAction Stop
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice -ne "") { try { $s.SelectVoice($Voice) } catch { } }
  $s.Rate = $Rate
  $s.Speak($Text)
  $s.Dispose()
  exit 0
} catch {
  # Absence and failure must differ: say WHY rather than exiting silently.
  Write-Error ("speech unavailable: " + $_.Exception.Message)
  exit 1
}
