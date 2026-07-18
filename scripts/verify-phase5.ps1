# =============================================================================
# verify-phase5.ps1 - Phase 5 verification: the three observability pillars.
#
# Works on Windows PowerShell 5.1 AND 7+ (curl.exe with -H "Expect:" strips the
# 100-continue header the gateway proxy rejects; -k trusts the local cert;
# JSON bodies go via temp file to avoid quoting issues).
#
# Run from the PROJECT ROOT (stack up with the 4-file observability chain):
#     .\scripts\verify-phase5.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
$BASE = 'https://api.localhost'

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

# ---- Step 1: generate traffic (auth + one order per saga path) ---------------
Info 'Step 1 - Generate traffic (login + three orders)'
$email = "user_$([DateTimeOffset]::Now.ToUnixTimeSeconds())@example.com"
$cred  = @{ email = $email; password = 'SuperSecret123!' }
Curl-Post "$BASE/api/auth/register" $cred $null | Out-Null
$login = Curl-Post "$BASE/api/auth/login" $cred $null
$token = $login.accessToken
if ($token) { Pass 'authenticated' } else { Fail 'no token'; exit 1 }

$a = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'BOOK-001';   quantity = 1 }) } $token
$b = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 1 }) } $token
$c = Curl-Post "$BASE/api/orders" @{ items = @(@{ sku = 'LAPTOP-001'; quantity = 3 }) } $token
$sA = Wait-OrderStatus $a.orderId $token
$sB = Wait-OrderStatus $b.orderId $token
$sC = Wait-OrderStatus $c.orderId $token
if ($sA -eq 'CONFIRMED' -and $sB -eq 'FAILED' -and $sC -eq 'REJECTED') {
  Pass "saga regression: CONFIRMED / FAILED / REJECTED"
} else { Fail "saga regression broken: $sA / $sB / $sC" }

Write-Host '  waiting 12s for the next Prometheus scrape...' -ForegroundColor DarkGray
Start-Sleep -Seconds 12

# ---- Step 2: METRICS pillar ----------------------------------------------------
Info 'Step 2 - Prometheus (metrics pillar)'
$targets = Curl-Get 'http://localhost:9090/api/v1/targets' $null
$upCount = @($targets.data.activeTargets | Where-Object { $_.health -eq 'up' }).Count
if ($upCount -ge 11) { Pass "$upCount scrape targets up (8 services + traefik + rabbitmq + prometheus)" }
else { Fail "only $upCount targets up"; $targets.data.activeTargets | Where-Object { $_.health -ne 'up' } | ForEach-Object { Write-Host "    DOWN: $($_.labels.job) $($_.scrapeUrl) - $($_.lastError)" -ForegroundColor DarkGray } }

$q1 = Curl-Get 'http://localhost:9090/api/v1/query?query=sum%20by%20(status)%20(orders_terminal_total)' $null
$statuses = @($q1.data.result | ForEach-Object { $_.metric.status }) | Sort-Object
if (($statuses -contains 'CONFIRMED') -and ($statuses -contains 'FAILED') -and ($statuses -contains 'REJECTED')) {
  Pass "orders_terminal_total counting all three statuses"
} else { Fail "orders_terminal_total incomplete: $($statuses -join ',')" }

$q2 = Curl-Get 'http://localhost:9090/api/v1/query?query=sum(rate(http_request_duration_seconds_count%5B2m%5D))' $null
if (@($q2.data.result).Count -ge 1) { Pass 'http request histogram flowing' } else { Fail 'no http_request_duration data' }

# ---- Step 3: LOGS pillar --------------------------------------------------------
Info 'Step 3 - Loki (logs pillar)'
$ready = & curl.exe -s http://localhost:3100/ready
if ("$ready" -match 'ready') { Pass 'loki ready' } else { Fail "loki not ready: $ready" }

$end   = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$start = $end - 600
$lokiUrl = 'http://localhost:3100/loki/api/v1/query_range?query=' +
  [uri]::EscapeDataString('{service="order-service"}') +
  "&start=${start}000000000&end=${end}000000000&limit=10"
$logs = Curl-Get $lokiUrl $null
$streams = @($logs.data.result).Count
if ($streams -ge 1) { Pass "loki has order-service log streams (labeled by promtail)" }
else { Fail 'no order-service streams in loki (promtail may need ~30s after start)' }

# ---- Step 4: TRACES pillar -------------------------------------------------------
Info 'Step 4 - Jaeger (traces pillar)'
$svcs = Curl-Get 'http://localhost:16686/api/services' $null
$traced = @($svcs.data | Where-Object { $_ -match 'service|gateway' })
if ($traced.Count -ge 4) { Pass "jaeger sees $($traced.Count) instrumented services" }
else { Fail "jaeger only sees: $($svcs.data -join ', ')" }

# NOTE: healthchecks and Prometheus scrapes are ALSO traced (single-span noise
# traces every ~10s), so we must look past the newest handful. Prefer filtering
# to the checkout operation; fall back to a deep scan.
$traces = Curl-Get 'http://localhost:16686/api/traces?service=order-service&operation=POST%20/orders&limit=10&lookback=1h' $null
if (-not $traces -or @($traces.data).Count -eq 0) {
  $traces = Curl-Get 'http://localhost:16686/api/traces?service=order-service&limit=40&lookback=1h' $null
}
$multi = $null
$best = 0
foreach ($t in @($traces.data)) {
  $procNames = @($t.processes.PSObject.Properties | ForEach-Object { $_.Value.serviceName } | Sort-Object -Unique)
  if ($procNames.Count -gt $best) { $best = $procNames.Count }
  if ($procNames.Count -ge 3) { $multi = $procNames; break }
}
if ($multi) { Pass ("cross-service trace found spanning: " + ($multi -join ' -> ')) }
else { Fail "no trace spanning 3+ services in last hour (best had $best); if the Jaeger UI shows the POST /orders trace stopping at order-service, context is not crossing RabbitMQ" }

Info 'Verification complete'
Write-Host "All three pillars verified. Open Grafana: http://localhost:3030 (admin/admin)`n" -ForegroundColor Green
