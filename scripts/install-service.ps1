$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
$NodeBin = (Get-Command node).Source
$EnvFile = "$RepoDir\packages\server\.env"
$ServerScript = "$RepoDir\packages\server\dist\src\server.js"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Missing $EnvFile. Copy .env.example and fill in JWT_SECRET."
    exit 1
}

$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^([^#][^=]*)=(.*)$') {
        $envVars[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$action = New-ScheduledTaskAction -Execute $NodeBin -Argument $ServerScript -WorkingDirectory "$RepoDir\packages\server"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName "aux-server" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
Write-Host "aux server registered as a Task Scheduler task: aux-server"
Write-Host "It will start on next login. To start now: Start-ScheduledTask -TaskName aux-server"
