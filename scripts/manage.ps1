param([ValidateSet('start','watch','stop','status','install','uninstall')][string]$Action='start')
$ErrorActionPreference='Stop'
$taskProjectRoot = Split-Path -Parent $PSScriptRoot
$taskState = Join-Path $taskProjectRoot 'data\platform'
$taskName = 'CodexTraeGateway-' + ([Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($taskProjectRoot))).Substring(0,12))
function Get-GatewayProcess {
  try {
    $taskSavedProcess=Get-Content -LiteralPath (Join-Path $taskState 'service.lock') -Raw | ConvertFrom-Json
    $taskProcessValue=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSavedProcess.pid)" -ErrorAction SilentlyContinue
    if($taskProcessValue -and $taskProcessValue.CommandLine.Contains((Join-Path $taskProjectRoot 'dist\cli.js'))){return $taskProcessValue}
  } catch {}
  return $null
}
function Stop-Watcher {
  $taskScheduled=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if($taskScheduled -and $taskScheduled.Actions.Arguments -match '\s+watch$'){Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue}
  $taskWatchPath=Join-Path $taskState 'watch.lock'
  if(Test-Path -LiteralPath $taskWatchPath){
    $taskWatchSaved=Get-Content -LiteralPath $taskWatchPath -Raw | ConvertFrom-Json
    $taskWatchProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($taskWatchSaved.pid)" -ErrorAction SilentlyContinue
    if($taskWatchProcess -and $taskWatchProcess.CommandLine.Contains($PSCommandPath) -and $taskWatchProcess.CommandLine -match '\s+watch(?:\s|$)'){Stop-Process -Id $taskWatchSaved.pid}
  }
}
function Start-Gateway {
  $taskLock = Join-Path $taskState 'service.lock'
  if(Test-Path -LiteralPath $taskLock){$taskSaved = Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json; $taskExisting = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSaved.pid)" -ErrorAction SilentlyContinue; if($taskExisting -and $taskExisting.CommandLine.Contains((Join-Path $taskProjectRoot 'dist\cli.js'))){Write-Output 'Gateway is already running';return}}
  New-Item -ItemType Directory -Force -Path $taskState | Out-Null
  $taskSettingsFile=Join-Path $taskState 'settings.json'
  if(Test-Path -LiteralPath $taskSettingsFile){$taskSettingsValue=Get-Content -LiteralPath $taskSettingsFile -Raw|ConvertFrom-Json;if($taskSettingsValue.workbuddy.executable){try{& (Join-Path $PSScriptRoot 'start-workbuddy.ps1') -WorkBuddyExecutable $taskSettingsValue.workbuddy.executable -CdpPort $taskSettingsValue.workbuddy.cdpPort}catch{Write-Warning $_.Exception.Message}}}
  $taskNode = (Get-Command node.exe).Source
  $taskEntry = Join-Path $taskProjectRoot 'dist\cli.js'
  Start-Process -FilePath $taskNode -ArgumentList @(('"'+$taskEntry+'"'),'serve') -WorkingDirectory $taskProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskState 'service.stdout.log') -RedirectStandardError (Join-Path $taskState 'service.stderr.log') | Out-Null
  Write-Output 'Gateway started'
}
switch($Action){
 'start' {
   $taskScheduled=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
   if($taskScheduled -and $taskScheduled.Actions.Arguments -match '\s+watch$'){Start-ScheduledTask -TaskName $taskName;Write-Output 'Gateway watcher started'}else{Start-Gateway}
 }
 'watch' {
   New-Item -ItemType Directory -Force -Path $taskState | Out-Null
   $taskWatchLock=Join-Path $taskState 'watch.lock';$taskWatchOwner=[guid]::NewGuid().ToString()
   @{pid=$PID;owner=$taskWatchOwner} | ConvertTo-Json -Compress | Set-Content -LiteralPath $taskWatchLock -Encoding utf8
   try {
     while($true){
       if(!(Get-GatewayProcess)){
         Add-Content -LiteralPath (Join-Path $taskState 'watch.log') -Value ((Get-Date).ToString('o')+' Gateway process unavailable; starting original durable service') -Encoding utf8
         try{Start-Gateway}catch{Add-Content -LiteralPath (Join-Path $taskState 'watch.log') -Value $_.Exception.Message -Encoding utf8}
       }
       Start-Sleep -Seconds 5
     }
   }finally{if(Test-Path -LiteralPath $taskWatchLock){$taskWatchLast=Get-Content -LiteralPath $taskWatchLock -Raw|ConvertFrom-Json;if($taskWatchLast.owner -eq $taskWatchOwner){Remove-Item -LiteralPath $taskWatchLock}}}
 }
 'status' {& node (Join-Path $taskProjectRoot 'dist\cli.js') status; exit $LASTEXITCODE}
 'stop' {
   Stop-Watcher
   $taskLock = Join-Path $taskState 'service.lock';if(!(Test-Path -LiteralPath $taskLock)){Write-Output 'Gateway is stopped';break}
   $taskSaved = Get-Content -LiteralPath $taskLock -Raw | ConvertFrom-Json
   $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskSaved.pid)" -ErrorAction SilentlyContinue
   if($taskProcess -and $taskProcess.CommandLine.Contains((Join-Path $taskProjectRoot 'dist\cli.js'))){Stop-Process -Id $taskSaved.pid;Write-Output 'Gateway stopped; desktop execution and task records are preserved'}
 }
 'install' {
   $taskShell=(Get-Command pwsh.exe).Source
   $taskArguments='-WindowStyle Hidden -NoProfile -NonInteractive -File "'+$PSCommandPath+'" watch'
   $taskAction=New-ScheduledTaskAction -Execute $taskShell -Argument $taskArguments -WorkingDirectory $taskProjectRoot
   $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
   $taskPrincipal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
   $taskSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
   Write-Output 'Installed login startup and gateway restart watcher';Start-ScheduledTask -TaskName $taskName
 }
 'uninstall' {Stop-Watcher;Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue;Write-Output 'Removed login startup and restart watcher; task records and extension remain'}
}
