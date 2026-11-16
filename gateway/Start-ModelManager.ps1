$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-AiModelGateway.ps1')
$token = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'manager-token')).Trim()
Start-Process ('http://127.0.0.1:8791/manage#' + $token)
