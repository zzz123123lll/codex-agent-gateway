param([string]$WorkBuddyExecutable=$env:WORKBUDDY_EXECUTABLE,[int]$CdpPort=0)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskSettingsFile=Join-Path $taskRoot 'data\platform\settings.json'
if(Test-Path -LiteralPath $taskSettingsFile){$taskSettings=Get-Content -LiteralPath $taskSettingsFile -Raw|ConvertFrom-Json;if(!$WorkBuddyExecutable){$WorkBuddyExecutable=$taskSettings.workbuddy.executable};if(!$CdpPort){$CdpPort=$taskSettings.workbuddy.cdpPort}}
if(!$CdpPort){$CdpPort=18491}
if($CdpPort -lt 1 -or $CdpPort -gt 65535){throw 'Invalid WorkBuddy CDP port'}
if(!$WorkBuddyExecutable -or !(Test-Path -LiteralPath $WorkBuddyExecutable -PathType Leaf)){throw 'Pass an existing -WorkBuddyExecutable path'}
$WorkBuddyExecutable=(Resolve-Path -LiteralPath $WorkBuddyExecutable).Path
$taskListeners=@(Get-NetTCPConnection -LocalPort $CdpPort -State Listen -ErrorAction SilentlyContinue)
if($taskListeners.Count){foreach($taskListener in $taskListeners){$taskOwner=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskListener.OwningProcess)";if($taskListener.LocalAddress -ne '127.0.0.1' -or $taskOwner.ExecutablePath -ne $WorkBuddyExecutable){throw 'Port belongs to another process; nothing was restarted'}};Write-Output 'WorkBuddy native port is already available';exit 0}
$taskRunning=@(Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'"|Where-Object {$_.ExecutablePath -eq $WorkBuddyExecutable})
if($taskRunning.Count){throw 'WorkBuddy is already running without its local connection port. Finish its work, quit normally using About > Quit WorkBuddy, then run this script again. No process was stopped.'}
$taskPriorPort=$env:WORKBUDDY_REMOTE_DEBUGGING_PORT
try{$env:WORKBUDDY_REMOTE_DEBUGGING_PORT=[string]$CdpPort;Start-Process -FilePath $WorkBuddyExecutable -WindowStyle Hidden|Out-Null}finally{$env:WORKBUDDY_REMOTE_DEBUGGING_PORT=$taskPriorPort}
Write-Output 'WorkBuddy started with its native loopback connection port; the gateway will verify readiness per task'
