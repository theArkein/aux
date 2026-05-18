$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
$NodeBin = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodeBin) {
    Write-Error "node not found in PATH. Install Node.js >= 20."
    exit 1
}
$EnvFile = "$RepoDir\packages\server\.env"
$ServerScript = "$RepoDir\packages\server\dist\src\server.js"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Missing $EnvFile. Copy .env.example and fill in JWT_SECRET."
    exit 1
}

if (-not (Test-Path $ServerScript)) {
    Write-Error "Server not built. Run: npm run build --workspace=packages/server"
    exit 1
}

$action = New-ScheduledTaskAction -Execute $NodeBin -Argument "`"$ServerScript`"" -WorkingDirectory "$RepoDir\packages\server"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName "aux-server" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
Write-Host "aux server registered as a Task Scheduler task: aux-server"
Write-Host "It will start on next login. To start now: Start-ScheduledTask -TaskName aux-server"
