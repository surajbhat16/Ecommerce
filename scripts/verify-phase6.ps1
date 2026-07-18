# =============================================================================
# verify-phase6.ps1 - Phase 6 verification: delivery-layer checks (local).
#
# Read-only: verifies lockfiles, workflow presence, and - the important one -
# that the RENDERED prod compose chain exposes only ports 80/443 and runs two
# gateway replicas. Works on Windows PowerShell 5.1 and 7+.
#
# Run from the PROJECT ROOT:
#     .\scripts\verify-phase6.ps1
# =============================================================================

$ErrorActionPreference = 'Stop'

function Pass($msg) { Write-Host "  PASS  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red }
function Info($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

$services = @('gateway','auth','catalog','cart','order','payment','inventory','notification')

# ---- Step 1: reproducible installs -------------------------------------------
Info 'Step 1 - Lockfiles present (npm ci path active in Docker builds)'
$missing = @($services | Where-Object { -not (Test-Path "services/$_/package-lock.json") })
if ($missing.Count -eq 0) { Pass 'all 8 services have package-lock.json' }
else { Fail "missing lockfiles: $($missing -join ', ')" }

# ---- Step 2: pipeline files ----------------------------------------------------
Info 'Step 2 - Pipeline files present'
foreach ($f in @('.github/workflows/ci.yml','scripts/smoke-ci.sh','scripts/wait-healthy.sh','docker-compose.prod.yml')) {
  if (Test-Path $f) { Pass $f } else { Fail "$f missing" }
}

# ---- Step 3: rendered prod chain ------------------------------------------------
Info 'Step 3 - Prod chain renders with correct posture'
$json = docker compose -f docker-compose.yml -f docker-compose.data.yml -f docker-compose.prod.yml config --format json 2>$null | ConvertFrom-Json
if (-not $json) { Fail 'could not render prod chain (is Docker running?)'; exit 1 }

# 3a. Only 80/443 published anywhere
$published = @()
foreach ($p in $json.services.PSObject.Properties) {
  foreach ($port in @($p.Value.ports)) {
    if ($port.published) { $published += "$($p.Name):$($port.published)" }
  }
}
$unexpected = @($published | Where-Object { $_ -notmatch ':(80|443)$' })
if ($unexpected.Count -eq 0 -and $published.Count -eq 2) {
  Pass "only edge ports published: $($published -join ', ')"
} else {
  Fail "unexpected published ports: $($published -join ', ')"
}

# 3b. Gateway replicas = 2
$reps = $json.services.'api-gateway'.deploy.replicas
if ($reps -eq 2) { Pass 'api-gateway replicas = 2' } else { Fail "api-gateway replicas = $reps (expected 2)" }

# 3c. Hardening applied everywhere
$noHardening = @()
foreach ($p in $json.services.PSObject.Properties) {
  if (-not ($p.Value.security_opt -contains 'no-new-privileges:true')) { $noHardening += $p.Name }
}
if ($noHardening.Count -eq 0) { Pass 'no-new-privileges on every service' }
else { Fail "hardening missing on: $($noHardening -join ', ')" }

# 3d. NODE_ENV=production on app services
$notProd = @()
foreach ($name in @('api-gateway','auth-service','catalog-service','cart-service','order-service','payment-service','inventory-service','notification-service')) {
  $env = $json.services.$name.environment
  if ($env.NODE_ENV -ne 'production') { $notProd += $name }
}
if ($notProd.Count -eq 0) { Pass 'NODE_ENV=production on all app services' }
else { Fail "NODE_ENV not production on: $($notProd -join ', ')" }

Info 'Verification complete'
Write-Host "Delivery layer verified. To exercise the prod chain itself, see docs/PHASE6_RUNBOOK.md`n" -ForegroundColor Green
