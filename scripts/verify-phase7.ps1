# =============================================================================
# verify-phase7.ps1 - Phase 7 verification: the storefront UI + its routing.
#
# Confirms the SPA is served at app.localhost, that same-origin /api/* is
# routed to the gateway, and that a browser-style flow (register -> login ->
# add to cart -> place order) works end to end through the UI's origin.
#
# Works on Windows PowerShell 5.1 and 7+ (curl.exe with -H "Expect:").
# Run from the PROJECT ROOT:  .\scripts\verify-phase7.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'
$APP = 'https://app.localhost'

function Pass($m) { Write-Host "  PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red }
function Info($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

function Curl-Post($url, $bodyObj, $bearer) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    ($bodyObj | ConvertTo-Json -Compress -Depth 6) | Set-Content -Path $tmp -Encoding ascii -NoNewline
    $a = @('-sk','-X','POST',$url,'-H','content-type: application/json','-H','Expect:','--data-binary',"@$tmp")
    if ($bearer) { $a += @('-H', "authorization: Bearer $bearer") }
    $raw = & curl.exe @a
  } finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return ($raw | ConvertFrom-Json)
}
function Curl-Get($url, $bearer) {
  $a = @('-sk','-X','GET',$url,'-H','Expect:')
  if ($bearer) { $a += @('-H', "authorization: Bearer $bearer") }
  $raw = & curl.exe @a
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw
}

# ---- Step 1: the SPA is served at app.localhost ------------------------------
Info 'Step 1 - Storefront SPA served at app.localhost'
$html = Curl-Get "$APP/" $null
if ($html -match '<div id="root">' -and $html -match 'Meridian') {
  Pass 'index.html served (SPA shell present)'
} else { Fail 'storefront HTML not served at app.localhost' }

# ---- Step 2: same-origin /api routes to the gateway --------------------------
Info 'Step 2 - Same-origin /api routes to the gateway'
$email = "ui_$([DateTimeOffset]::Now.ToUnixTimeSeconds())@example.com"
$cred  = @{ email = $email; password = 'SuperSecret123!' }
Curl-Post "$APP/api/auth/register" $cred $null | Out-Null
$login = Curl-Post "$APP/api/auth/login" $cred $null
$token = $login.accessToken
if ($token) { Pass 'register + login via app.localhost/api (same-origin API works)' }
else { Fail 'auth via app.localhost/api failed - is the storefront-api router up?' }

# ---- Step 3: catalog reads through the UI origin -----------------------------
Info 'Step 3 - Catalog reads through the UI origin'
$raw = Curl-Get "$APP/api/catalog/categories/electronics/products" $null
$cat = $raw | ConvertFrom-Json
$laptop = @($cat.products | Where-Object { $_.sku -eq 'LAPTOP-001' })
if ($laptop.Count -ge 1) { Pass "catalog returned electronics ($($cat.products.Count) products)" }
else { Fail 'catalog did not return expected products' }

# ---- Step 4: full browser-style order flow -----------------------------------
Info 'Step 4 - Browser-style order flow (add to cart -> place order)'
Curl-Post "$APP/api/cart/cart/items" @{ sku='BOOK-001'; quantity=1 } $token | Out-Null
$order = Curl-Post "$APP/api/orders" @{ items=@(@{ sku='BOOK-001'; quantity=1 }) } $token
if ($order.orderId) { Pass "order placed via UI origin: $($order.orderId)" }
else { Fail 'order placement through app.localhost failed' }

# poll to terminal
$status = 'PENDING'
for ($i=0; $i -lt 15; $i++) {
  $o = (Curl-Get "$APP/api/orders/$($order.orderId)" $token | ConvertFrom-Json).order
  $status = $o.status
  if ('CONFIRMED','FAILED','REJECTED' -contains $status) { break }
  Start-Sleep -Milliseconds 700
}
if ($status -eq 'CONFIRMED') { Pass "order reached CONFIRMED through the UI path" }
else { Fail "order status was $status (expected CONFIRMED)" }

Info 'Verification complete'
Write-Host "Open the storefront: https://app.localhost  (accept the self-signed cert)`n" -ForegroundColor Green
