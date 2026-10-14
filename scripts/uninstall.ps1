$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'environment.ps1')
$taskExtensionConfig=Join-Path $env:APPDATA 'Trae CN\User\globalStorage\local-codex.codex-trae-bridge\gateway.json'
$taskOwnsBridge=$false
if(Test-Path -LiteralPath $taskExtensionConfig){
  $taskBridge=Get-Content -LiteralPath $taskExtensionConfig -Raw|ConvertFrom-Json
  if($taskBridge.stateDirectory -ne (Join-Path $taskRoot 'data\platform')){throw 'The desktop bridge belongs to another gateway directory; no integration was removed'}
  $taskOwnsBridge=$true
}
$taskRuns=& node (Join-Path $taskRoot 'dist\cli.js') list 2>$null
if($LASTEXITCODE -eq 0){$taskRunning=($taskRuns|ConvertFrom-Json).runs|Where-Object {$_.holdsCapacity};if($taskRunning){throw 'Finish or cancel the active desktop tasks before uninstalling'}}
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'manage.ps1') uninstall
& pwsh -NoProfile -File (Join-Path $PSScriptRoot 'manage.ps1') stop
$taskRaw=& codex mcp get trae-gateway --json 2>$null
if($LASTEXITCODE -eq 0){$taskConfig=$taskRaw|ConvertFrom-Json;if($taskConfig.transport.args[0] -eq (Join-Path $taskRoot 'dist\platform\mcp.js')){& codex mcp remove trae-gateway}}
$taskSkill=Join-Path (Get-GatewayCodexRoot) 'skills\trae-executor\SKILL.md'
if((Test-Path -LiteralPath $taskSkill) -and (Get-Content -LiteralPath $taskSkill -Raw) -eq (Get-Content -LiteralPath (Join-Path $taskRoot 'skills\trae-executor\SKILL.md') -Raw)){Remove-Item -LiteralPath $taskSkill}
$taskAgentSkill=Join-Path (Get-GatewayCodexRoot) 'skills\agent-executor\SKILL.md'
if((Test-Path -LiteralPath $taskAgentSkill) -and (Get-Content -LiteralPath $taskAgentSkill -Raw) -eq (Get-Content -LiteralPath (Join-Path $taskRoot 'skills\agent-executor\SKILL.md') -Raw)){Remove-Item -LiteralPath $taskAgentSkill}
$taskSettings=Join-Path $taskRoot 'data\platform\settings.json'
if($taskOwnsBridge -and (Test-Path -LiteralPath $taskSettings)){$taskSettingsValue=Get-Content -LiteralPath $taskSettings -Raw|ConvertFrom-Json;$taskCli=Join-Path (Split-Path -Parent $taskSettingsValue.executable) 'bin\trae-cn.cmd';if(Test-Path -LiteralPath $taskCli){& $taskCli --uninstall-extension local-codex.codex-trae-bridge}}
if(Test-Path -LiteralPath $taskExtensionConfig){$taskBridge=Get-Content -LiteralPath $taskExtensionConfig -Raw|ConvertFrom-Json;if($taskBridge.stateDirectory -eq (Join-Path $taskRoot 'data\platform')){Remove-Item -LiteralPath $taskExtensionConfig}}
Write-Output 'Gateway integration removed. Task records and business files preserved. Existing TRAE windows finish unloading the extension when closed normally.'
