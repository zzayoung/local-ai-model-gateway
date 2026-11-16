param([Parameter(Mandatory)][ValidateSet('DeepSeek','WorkBuddy')][string]$Client)
$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'deployment.json') | ConvertFrom-Json
& (Join-Path $PSScriptRoot 'Start-AiModelGateway.ps1')
if ($Client -eq 'DeepSeek') {
    $exe = $config.harnessExe
    $env:DSH_HOME = $config.harnessHome
    $env:NODE_USE_ENV_PROXY = '1'
    $env:WORKBUDDY_BRIDGE_KEY = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'gateway-token')).Trim()
} else {
    $exe = $config.workBuddyExe
}
if (!$exe -or !(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Set the installed executable path in deployment.json.' }
Start-Process -FilePath $exe -WindowStyle Normal
