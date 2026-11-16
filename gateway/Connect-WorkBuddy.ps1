param([ValidateSet('cn','global')][string]$Region = 'cn')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'Start-AiModelGateway.ps1')
$token = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'gateway-token')).Trim()
$headers = @{Authorization = 'Bearer ' + $token}
$endpoint = 'http://127.0.0.1:8791/v1/auth/device'
$reply = Invoke-RestMethod -Method Post -Uri $endpoint -Headers $headers -ContentType 'application/json' `
    -Body (@{region = $Region} | ConvertTo-Json -Compress) -TimeoutSec 20
$authorization = [Uri]$reply.url
if ($authorization.Scheme -ne 'https') { throw 'Expected an HTTPS WorkBuddy authorization URL.' }
Start-Process -FilePath $authorization.AbsoluteUri -WindowStyle Normal
Write-Host 'Complete WorkBuddy authorization in the browser.'
$poll = $endpoint + '?state=' + [Uri]::EscapeDataString($reply.state)
while ((Get-Date).ToUniversalTime() -lt ([DateTimeOffset]::Parse($reply.expiresAt)).UtcDateTime) {
    Start-Sleep -Seconds 4
    $status = Invoke-RestMethod -Uri $poll -Headers $headers -TimeoutSec 20
    if ($status.status -eq 'ready') {
        if ($status.stored.degraded) { throw 'WorkBuddy authorized, but DPAPI could not save the credential for the next sign-in.' }
        Write-Host 'WorkBuddy authorization complete.'
        return
    }
}
throw 'The device authorization expired. Run this command again.'
