$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'deployment.json') | ConvertFrom-Json
$session = (Get-Process -Id $PID).SessionId
$clients = @(
    @{
        Name = 'Claude Code'
        Exe = $config.claudeExe
        Launcher = (Join-Path $PSScriptRoot 'Start-ClaudeCode.ps1')
        Workspace = (Join-Path $config.claudeHome 'workspace')
    }
    @{ Name = 'DeepSeek Harness'; Exe = $config.harnessExe }
    @{ Name = 'WorkBuddy'; Exe = $config.workBuddyExe }
)

function Get-ClientProcess($executable) {
    $name = [System.IO.Path]::GetFileNameWithoutExtension($executable)
    Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq $session -and $_.Path -eq $executable
    }
}

$results = foreach ($client in $clients) {
    $entry = @{ name = $client.Name; status = 'inactive' }
    try {
        $running = @(if ($client.Exe) { Get-ClientProcess $client.Exe })
        if ($running.Count -gt 0) {
            foreach ($process in $running) {
                if ($process.MainWindowHandle) { [void]$process.CloseMainWindow() }
            }
            if (!$client.Launcher) {
                $running | Wait-Process -Timeout 3 -ErrorAction SilentlyContinue
            }
            $remaining = @(Get-ClientProcess $client.Exe)
            if ($remaining.Count -gt 0) {
                $remaining | Stop-Process -Force
                $remaining | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
            }
            if (Get-ClientProcess $client.Exe) { throw 'Could not close the existing process.' }

            if ($client.Launcher) {
                Start-Process -FilePath powershell.exe -ArgumentList ('-NoProfile -File "' + $client.Launcher + '"') `
                    -WorkingDirectory $client.Workspace -WindowStyle Normal
            } else {
                if ($client.Name -eq 'DeepSeek Harness') {
                    $env:DSH_HOME = $config.harnessHome
                    $env:WORKBUDDY_BRIDGE_KEY = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'gateway-token')).Trim()
                    $env:NODE_USE_ENV_PROXY = '1'
                }
                Start-Process -FilePath $client.Exe -WindowStyle Normal
            }
            $deadline = (Get-Date).AddSeconds(10)
            do {
                Start-Sleep -Milliseconds 300
                $started = @(Get-ClientProcess $client.Exe)
            } until ($started.Count -gt 0 -or (Get-Date) -ge $deadline)
            if ($started.Count -eq 0) { throw 'The new process did not start.' }
            $entry.status = 'restarted'
        }
    } catch {
        $entry.status = 'failed'
        $entry.error = $_.Exception.Message
    }
    $entry
}

ConvertTo-Json -InputObject @($results) -Compress
