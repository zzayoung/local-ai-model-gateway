$ErrorActionPreference = 'Stop'
$config = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'deployment.json') | ConvertFrom-Json
$homeDir = $config.claudeHome
$env:CLAUDE_CONFIG_DIR = Join-Path $homeDir 'config'
$gateway = $PSScriptRoot
& (Join-Path $PSScriptRoot 'Start-AiModelGateway.ps1')
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8791'
$env:ANTHROPIC_AUTH_TOKEN = (Get-Content -Raw -LiteralPath (Join-Path $gateway 'gateway-token')).Trim()
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = '272000'
$model = 'glm-5.3-flash'
$env:ANTHROPIC_API_KEY = ''
$env:ANTHROPIC_DEFAULT_MODEL = $model
$env:ANTHROPIC_MODEL = $model
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = $model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $model
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = $model
$env:CLAUDE_CODE_SUBAGENT_MODEL = $model
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:DISABLE_AUTOUPDATER = '1'
$claude = $config.claudeExe
if (!$claude -or !(Test-Path -LiteralPath $claude -PathType Leaf)) { throw 'Set claudeExe in deployment.json.' }
if ((Get-Location).Path -eq $gateway) { Set-Location (Join-Path $homeDir 'workspace') }
& $claude --settings (Join-Path $gateway 'claude-settings.json') @args
exit $LASTEXITCODE
