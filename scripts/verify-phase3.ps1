# =============================================================================
# verify-phase3.ps1 - End-to-end Phase 3 checkout-saga verification.
#
# Works on Windows PowerShell 5.1 AND 7+. Uses curl.exe for all HTTP so it
# avoids 5.1's Invoke-RestMethod quirks (self-signed cert + Expect header).
# JSON bodies are written to a temp file and sent with -d "@file" to avoid
# any command-line quoting problems.
#
# Run from the PROJECT ROOT:
#     .\scripts\verify-phase3.ps1
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

# --- curl.exe-based HTTP. Body written to a temp file (-d @file) so there is
#     NO shell quoting to mangle. "-H Expect:" strips the 100-continue header
#     that the proxy rejects on some clients. -k trusts the self-signed cert. ---
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

# ---- Step 1: authenticate ---------------------------------------------------
Info 'Step 1 - Authenticate (register + login, capture JWT)'
$email = "user_$([DateTimeOffset]::Now.ToUnixTimeSeconds())@example.com"
$pass  = 'SuperSecret123!'
$cred  = @{ email = $email; password = $pass }

Curl-Post "$BASE/api/auth/register" $cred $null | Out-Null
$login = Curl-Post "$BASE/api/auth/login" $cred $null
$token = $login.accessToken
if ($token) { Pass "got JWT for $email" } else { Fail 'no token returned'; exit 1 }

# ---- Step 2: baseline stock -------------------------------------------------
Info 'Step 2 - Baseline stock'
$stock0 = (Curl-Get 'http://localhost:3005/stock' $null).stock
$stock0 | Format-Table sku, available, reserved | Out-String | Write-Host
$laptop0 = ($stock0 | Where-Object { $_.sku -eq 'LAPTOP-001' })
if ($laptop0.available -ge 2) {
  Pass "LAPTOP-001 available = $($laptop0.available)"
} else {
  Fail "LAPTOP-001 only $($laptop0.available) - demos may be ambiguous; consider a clean restart"
}

# ---- Step 3: CONFIRMED path -------------------------------------------------
Info 'Step 3 - CONFIRMED path (BOOK-001 x1)'
$a  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'BOOK-001'; quantity = 1 }) } $token
$sA = Wait-OrderStatus $a.orderId $token
if ($sA -eq 'CONFIRMED') { Pass "order $($a.orderId) -> CONFIRMED" } else { Fail "expected CONFIRMED, got $sA" }

# ---- Step 4: FAILED + compensation ------------------------------------------
Info 'Step 4 - FAILED + compensation (LAPTOP-001 x1)'
$b  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 1 }) } $token
$sB = Wait-OrderStatus $b.orderId $token
if ($sB -eq 'FAILED') { Pass "order $($b.orderId) -> FAILED" } else { Fail "expected FAILED, got $sB" }

Start-Sleep -Seconds 1
$laptop1 = ((Curl-Get 'http://localhost:3005/stock' $null).stock | Where-Object { $_.sku -eq 'LAPTOP-001' })
if ($laptop1.available -eq $laptop0.available -and $laptop1.reserved -eq 0) {
  Pass "compensation restored LAPTOP-001 to available=$($laptop1.available), reserved=0"
} else {
  Fail "stock not restored: available=$($laptop1.available), reserved=$($laptop1.reserved)"
}

# ---- Step 5: REJECTED path --------------------------------------------------
Info 'Step 5 - REJECTED path (LAPTOP-001 x3, only 2 in stock)'
$c  = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 3 }) } $token
$sC = Wait-OrderStatus $c.orderId $token
if ($sC -eq 'REJECTED') { Pass "order $($c.orderId) -> REJECTED" } else { Fail "expected REJECTED, got $sC" }

# ---- Step 6: DB-level evidence ----------------------------------------------
Info 'Step 6 - Under-the-hood evidence'

$unpub = (docker @COMPOSE exec -T order-db psql -U orderuser -d orderdb -tAc `
  "SELECT count(*) FROM outbox WHERE published = FALSE;").Trim()
if ($unpub -eq '0') { Pass "outbox fully drained (0 unpublished)" } else { Fail "$unpub unpublished outbox rows" }

$proc = (docker @COMPOSE exec -T inventory-db psql -U inventoryuser -d inventorydb -tAc `
  "SELECT count(*) FROM processed_reservations;").Trim()
if ([int]$proc -ge 2) { Pass "processed_reservations has $proc rows (idempotency working)" } else { Fail "processed_reservations only $proc rows" }

Write-Host "`n  Recent orders by status:" -ForegroundColor DarkGray
docker @COMPOSE exec -T order-db psql -U orderuser -d orderdb -c `
  "SELECT status, count(*) FROM orders GROUP BY status ORDER BY status;"

$dlq = docker @COMPOSE exec -T rabbitmq rabbitmqctl list_queues name messages 2>$null | Select-String -Pattern 'dl|dead|rejected'
if ($dlq) { Write-Host "  DLQ rows:`n$dlq" -ForegroundColor DarkGray } else { Pass 'no dead-letter queue backlog' }

Info 'Verification complete'
Write-Host "If every line above says PASS, Phase 3 is working end-to-end.`n" -ForegroundColor Green
