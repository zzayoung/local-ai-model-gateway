$ErrorActionPreference = 'Stop'
$gateway = $PSScriptRoot
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'deployment.json') | ConvertFrom-Json
$env:DSH_HOME = $config.harnessHome
$env:NO_PROXY = (@($env:NO_PROXY, '127.0.0.1', 'localhost') | Where-Object { $_ }) -join ','
$healthUrl = 'http://127.0.0.1:8791/health'
try { $status = Invoke-RestMethod $healthUrl -TimeoutSec 2 } catch { $status = $null }
if ($status.service -eq 'local-ai-model-gateway' -and $status.version -eq 2) { return }
if ($status) { throw 'Port 8791 is already serving a different gateway.' }

$runtime = Join-Path $gateway 'workbuddy-runtime'
$env:WORKBUDDY_DATA_DIR = $runtime
$env:WORKBUDDY_LOCAL_TOKEN = (Get-Content -Raw -LiteralPath (Join-Path $runtime 'bridge-token')).Trim()
$env:WORKBUDDY_CREDENTIAL_SOURCE = 'plugin'
$env:WORKBUDDY_CREDENTIAL_STORE = 'dpapi'
$env:WORKBUDDY_AUTH_DIR = $runtime
$env:WORKBUDDY_AUTH_FILE = Join-Path $runtime 'desktop-session-unused.info'
$env:WORKBUDDY_AUTO_CHECKIN = '0'
$env:WORKBUDDY_11128_FALLBACK = '1'
$env:WORKBUDDY_LOG = '0'
$env:CODEBUDDY_API_KEY = ''
$env:CODEBUDDY_ENDPOINT = ''

$node = $config.node
$process = Start-Process -FilePath $node -ArgumentList ('--use-env-proxy "' + (Join-Path $gateway 'openai-claude-gateway.mjs') + '"') `
    -WorkingDirectory $gateway -WindowStyle Hidden -RedirectStandardOutput (Join-Path $gateway 'access.log') `
    -RedirectStandardError (Join-Path $gateway 'error.log') -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $status = Invoke-RestMethod $healthUrl -TimeoutSec 2 } catch { $status = $null }
    if ($status.service -eq 'local-ai-model-gateway' -and $status.version -eq 2) { return }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 250
}
throw "AI model gateway failed to start. See $gateway\error.log."
