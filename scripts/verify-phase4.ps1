# =============================================================================
# verify-phase4.ps1 - Phase 4 verification: saga regression + event fan-out.
#
# Works on Windows PowerShell 5.1 AND 7+ (curl.exe with -H "Expect:" strips the
# 100-continue header that the gateway proxy rejects; -k trusts the local cert;
# JSON bodies go via temp file to avoid quoting issues).
#
# Run from the PROJECT ROOT:
#     .\scripts\verify-phase4.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
$BASE = 'https://api.localhost'

$COMPOSE = @(
  'compose',
  '-f', 'docker-compose.yml',
  '-f', 'docker-compose.data.yml',
  '-f', 'docker-compose.override.yml'
)

function Pass($msg) { Write-Host "  PASS  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

function Curl-Post($url, $bodyObj, $bearer) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    ($bodyObj | ConvertTo-Json -Compress -Depth 6) | Set-Content -Path $tmp -Encoding ascii -NoNewline
    $curlArgs = @('-sk', '-X', 'POST', $url,
                  '-H', 'content-type: application/json',
                  '-H', 'Expect:',
                  '--data-binary', "@$tmp")
    if ($bearer) { $curlArgs += @('-H', "authorization: Bearer $bearer") }
    $raw = & curl.exe @curlArgs
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw | ConvertFrom-Json)
}
function Curl-Get($url, $bearer) {
  $curlArgs = @('-sk', '-X', 'GET', $url, '-H', 'Expect:')
  if ($bearer) { $curlArgs += @('-H', "authorization: Bearer $bearer") }
  $raw = & curl.exe @curlArgs
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw | ConvertFrom-Json)
}
function Wait-OrderStatus($orderId, $bearer, $timeoutSec = 15) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $terminal = @('CONFIRMED', 'FAILED', 'REJECTED')
  $last = 'UNKNOWN'
  while ((Get-Date) -lt $deadline) {
    $r = Curl-Get "$BASE/api/orders/$orderId" $bearer
    if ($r -and $r.order) { $last = $r.order.status }
    if ($terminal -contains $last) { return $last }
    Start-Sleep -Milliseconds 750
  }
  return $last
}
function Get-NotesFor($orderId) {
  $n = Curl-Get 'http://localhost:3006/notifications' $null
  if (-not $n) { return @() }
  return @($n.notifications | Where-Object { $_.orderId -eq $orderId })
}

# ---- Step 1: authenticate ---------------------------------------------------
Info 'Step 1 - Authenticate'
$email = "user_$([DateTimeOffset]::Now.ToUnixTimeSeconds())@example.com"
$cred  = @{ email = $email; password = 'SuperSecret123!' }
Curl-Post "$BASE/api/auth/register" $cred $null | Out-Null
$login = Curl-Post "$BASE/api/auth/login" $cred $null
$token = $login.accessToken
if ($token) { Pass "got JWT for $email" } else { Fail 'no token returned'; exit 1 }

# ---- Step 2: notification service is up and subscribed ----------------------
Info 'Step 2 - Notification service health + queue binding'
$health = Curl-Get 'http://localhost:3006/health/ready' $null
if ($health -and $health.status -eq 'ready') { Pass 'notification-service ready (channel open)' } else { Fail 'notification-service not ready' }

$bindings = docker @COMPOSE exec -T rabbitmq rabbitmqctl list_bindings source_name destination_name routing_key 2>$null | Select-String -Pattern 'notification.events'
$bindCount = @($bindings).Count
if ($bindCount -ge 4) { Pass "notification.events bound to the exchange ($bindCount bindings)" } else { Fail "expected >= 4 bindings, found $bindCount" }

# ---- Step 3: CONFIRMED order fans out ----------------------------------------
Info 'Step 3 - CONFIRMED order (BOOK-001 x1) -> 2 notifications'
$a  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'BOOK-001'; quantity = 1 }) } $token
$sA = Wait-OrderStatus $a.orderId $token
if ($sA -eq 'CONFIRMED') { Pass "order -> CONFIRMED (saga regression ok)" } else { Fail "expected CONFIRMED, got $sA" }
Start-Sleep -Seconds 2
$nA = Get-NotesFor $a.orderId
$subjA = @($nA | ForEach-Object { $_.subject })
if ($subjA -contains 'We received your order' -and $subjA -contains 'Your order is confirmed') {
  Pass "fan-out delivered both notifications ($($nA.Count) total)"
} else { Fail "notifications for CONFIRMED order incomplete: $($subjA -join ' | ')" }
$attributed = @($nA | Where-Object { $_.to -ne 'user:unknown' })
if ($attributed.Count -eq $nA.Count -and $nA.Count -gt 0) {
  Pass "all notifications attributed to a real user ($($nA[0].to))"
} else { Fail 'some notifications attributed to user:unknown' }

# ---- Step 4: FAILED order fans out -------------------------------------------
Info 'Step 4 - FAILED order (LAPTOP-001 x1) -> cancellation notification'
$b  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 1 }) } $token
$sB = Wait-OrderStatus $b.orderId $token
if ($sB -eq 'FAILED') { Pass 'order -> FAILED (compensation path ok)' } else { Fail "expected FAILED, got $sB" }
Start-Sleep -Seconds 2
$subjB = @((Get-NotesFor $b.orderId) | ForEach-Object { $_.subject })
if ($subjB -match 'Payment failed') { Pass 'payment-failed notification sent' } else { Fail "no cancellation notification: $($subjB -join ' | ')" }

# ---- Step 5: REJECTED order fans out ------------------------------------------
Info 'Step 5 - REJECTED order (LAPTOP-001 x3) -> out-of-stock notification'
$c  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 3 }) } $token
$sC = Wait-OrderStatus $c.orderId $token
if ($sC -eq 'REJECTED') { Pass 'order -> REJECTED' } else { Fail "expected REJECTED, got $sC" }
Start-Sleep -Seconds 2
$subjC = @((Get-NotesFor $c.orderId) | ForEach-Object { $_.subject })
if ($subjC -match 'out of stock') { Pass 'out-of-stock notification sent' } else { Fail "no rejection notification: $($subjC -join ' | ')" }

# ---- Step 6: producers unchanged / saga evidence intact -----------------------
Info 'Step 6 - Saga evidence intact (fan-out changed no producer behavior)'
$unpub = (docker @COMPOSE exec -T order-db psql -U orderuser -d orderdb -tAc `
  "SELECT count(*) FROM outbox WHERE published = FALSE;").Trim()
if ($unpub -eq '0') { Pass 'outbox fully drained' } else { Fail "$unpub unpublished outbox rows" }

$dlq = docker @COMPOSE exec -T rabbitmq rabbitmqctl list_queues name messages 2>$null | Select-String -Pattern 'dead'
Write-Host "  $dlq" -ForegroundColor DarkGray

Info 'Verification complete'
Write-Host "If every line above says PASS, Phase 4 fan-out is working end-to-end.`n" -ForegroundColor Green
