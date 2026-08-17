# KEEP PURE ASCII: PowerShell 5.1 reads .ps1 as ANSI without a BOM, and a UTF-8 dash
# inside a quoted string parses as an early string terminator.
# Toast notification helper. Kept as its own script because the notifications module
# (Mission Control, stage 3) will reuse it - one notification channel, not two.
#
#   powershell -NoProfile -File scripts/notify.ps1 -Title "..." -Message "..."
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message
)

try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

  # Escape for XML - a message containing & or < would otherwise silently produce no toast.
  $esc = { param($s) $s -replace '&', '&amp;' -replace '<', '&lt;' -replace '>', '&gt;' }
  $t = & $esc $Title
  $m = & $esc $Message

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$m</text></binding></visual></toast>")
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.WindowsPowerShell').Show($toast)
  exit 0
} catch {
  # A failed notification must be visible to the caller, not swallowed. The watchdog
  # logs this, because "we alerted you" and "we tried to alert you" are different facts.
  Write-Error "notify failed: $($_.Exception.Message)"
  exit 1
}
