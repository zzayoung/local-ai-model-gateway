[CmdletBinding()]
param(
    [string]$InstallRoot,
    [string]$HarnessExe,
    [string]$ClaudeExe,
    [string]$WorkBuddyExe,
    [switch]$SkipStart
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe).Source
$version = & $node --version
if ($version -notmatch '^v(\d+)\.(\d+)' -or [int]$Matches[1] -lt 24 -or
    ([int]$Matches[1] -eq 24 -and [int]$Matches[2] -lt 5)) {
    throw 'Node.js 24.5 or later is required.'
}
if (!$InstallRoot) {
    $InstallRoot = if (Test-Path -LiteralPath 'E:\') { 'E:\AI-Tools' } else { Join-Path $env:LOCALAPPDATA 'AI-Tools' }
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$gateway = Join-Path $InstallRoot 'Model Gateway'
$catalog = Join-Path $gateway 'models.json'
$source = Join-Path $PSScriptRoot 'gateway'
$harnessHome = Join-Path $InstallRoot 'DeepSeek Harness\home'
$harnessProfile = Join-Path $harnessHome 'profiles\desktop\cordis.patch.yml'
$claudeHome = Join-Path $InstallRoot 'Claude Code'
$workBuddyModels = Join-Path $env:USERPROFILE '.workbuddy\models.json'
$runtime = Join-Path $gateway 'workbuddy-runtime'
$utf8 = New-Object Text.UTF8Encoding($false)

if (!$HarnessExe) {
    $uninstall = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'DeepSeek Harness*' -and $_.InstallLocation } |
        Select-Object -First 1
    $candidates = @('E:\Deepseek Harness\DeepSeek Harness.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'))
    if ($uninstall) { $candidates += Join-Path $uninstall.InstallLocation 'DeepSeek Harness.exe' }
    $HarnessExe = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (!$ClaudeExe) {
    $managed = Join-Path $claudeHome 'runtime\node_modules\@anthropic-ai\claude-code-win32-x64\claude.exe'
    if (Test-Path -LiteralPath $managed -PathType Leaf) { $ClaudeExe = $managed }
    else { $ClaudeExe = (Get-Command claude.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source }
}
if (!$WorkBuddyExe) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\WorkBuddy\WorkBuddy.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $WorkBuddyExe = $candidate }
}
foreach ($program in @($HarnessExe, $ClaudeExe, $WorkBuddyExe)) {
    if ($program -and !(Test-Path -LiteralPath $program -PathType Leaf)) { throw "Executable not found: $program" }
}
# Existing clients should be closed while their model files are first generated.
if (!$SkipStart) {
    try { $running = Invoke-RestMethod -Uri 'http://127.0.0.1:8791/health' -TimeoutSec 2 } catch { $running = $null }
    if ($running) { throw 'Port 8791 already serves an application. Stop the existing gateway before installing or upgrading.' }
}
foreach ($dir in @($gateway, $runtime, (Split-Path $harnessProfile), (Split-Path $workBuddyModels),
    (Join-Path $claudeHome 'config'), (Join-Path $claudeHome 'workspace'))) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
}
$backup = Join-Path $InstallRoot ('Migration backups\gateway-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
foreach ($file in @($harnessProfile, $workBuddyModels, $catalog)) {
    if (Test-Path -LiteralPath $file) {
        New-Item -ItemType Directory -Path $backup -Force | Out-Null
        $destination = if ($file -eq $catalog) { Join-Path $backup 'gateway-models.json' } else { $backup }
        Copy-Item -LiteralPath $file -Destination $destination
    }
}
Get-ChildItem -LiteralPath $source | Where-Object { $_.Name -notin @('models.json', 'media-output') } |
    Copy-Item -Destination $gateway -Recurse -Force
Get-ChildItem -LiteralPath $source -Filter '*.ps1' -File | ForEach-Object {
    Unblock-File -LiteralPath (Join-Path $gateway $_.Name)
}
if (!(Test-Path -LiteralPath $catalog)) {
    Copy-Item -LiteralPath (Join-Path $source 'models.json') -Destination $gateway
}
$deployment = @{
    node = $node
    harnessHome = $harnessHome
    harnessExe = $HarnessExe
    claudeHome = $claudeHome
    claudeExe = $ClaudeExe
    workBuddyExe = $WorkBuddyExe
}
[IO.File]::WriteAllText((Join-Path $gateway 'deployment.json'), ($deployment | ConvertTo-Json), $utf8)
foreach ($path in @((Join-Path $gateway 'gateway-token'), (Join-Path $gateway 'manager-token'), (Join-Path $runtime 'bridge-token'))) {
    if (!(Test-Path -LiteralPath $path)) {
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        [IO.File]::WriteAllText($path, [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant(), $utf8)
    }
}
if (!(Test-Path -LiteralPath $workBuddyModels)) { [IO.File]::WriteAllText($workBuddyModels, '[]', $utf8) }
if (!(Test-Path -LiteralPath $harnessProfile)) {
    $profileTemplate = @'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: workbuddy
    model: glm-5.3-flash
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
'@
    [IO.File]::WriteAllText($harnessProfile, $profileTemplate + "`n", $utf8)
}
$claudeSettings = Join-Path $claudeHome 'config\.claude.json'
if (!(Test-Path -LiteralPath $claudeSettings)) {
    [IO.File]::WriteAllText($claudeSettings, '{"hasCompletedOnboarding":true}', $utf8)
}
$env:DSH_HOME = $harnessHome
& $node (Join-Path $gateway 'openai-claude-gateway.mjs') --sync (Join-Path $source 'models.json')
if ($LASTEXITCODE -ne 0) { throw 'Model catalog sync failed.' }
& $node (Join-Path $gateway 'install-media-clients.mjs') $env:USERPROFILE $harnessProfile $backup
if ($LASTEXITCODE -ne 0) { throw 'Media connector setup failed. See the configuration path above.' }
if (!$SkipStart) {
    & (Join-Path $gateway 'Start-AiModelGateway.ps1')
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $launcher = Join-Path $gateway 'Start-AiModelGateway.ps1'
    $powerShell = (Get-Command powershell.exe).Source
    $action = New-ScheduledTaskAction -Execute $powerShell -WorkingDirectory $gateway `
        -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'Local AI Model Gateway' -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Force | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    $desktop = [Environment]::GetFolderPath('Desktop')
    foreach ($app in @('Model Manager','Claude Code','DeepSeek Harness','WorkBuddy')) {
        $shortcut = $shell.CreateShortcut((Join-Path $desktop ($app + ' - Local Gateway.lnk')))
        $shortcut.TargetPath = Join-Path $gateway ($app + '.cmd')
        $shortcut.WorkingDirectory = $gateway
        $shortcut.Save()
    }
}
Write-Output ('Installed at ' + $gateway)
Write-Output 'gateway_media is configured for WorkBuddy, DeepSeek Harness and Antigravity.'
Write-Output 'In WorkBuddy, trust gateway_media in Custom Connectors the first time.'
if (!$ClaudeExe) { Write-Output 'Set claudeExe in deployment.json after installing Claude Code.' }
if (!$HarnessExe) { Write-Output 'Set harnessExe in deployment.json after installing DeepSeek Harness.' }
if (!$WorkBuddyExe) { Write-Output 'Set workBuddyExe in deployment.json after installing WorkBuddy.' }
