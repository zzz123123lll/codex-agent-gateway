param([string]$TraeExecutable=$env:TRAE_EXECUTABLE,[string]$WorkBuddyExecutable=$env:WORKBUDDY_EXECUTABLE,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'environment.ps1')
$taskPlan=Get-GatewaySetupPlan -Root $taskRoot -Executable $TraeExecutable -WorkBuddyExecutable $WorkBuddyExecutable
if($CheckOnly){$taskPlan|ConvertTo-Json;exit 0}
$TraeExecutable=$taskPlan.executable
$WorkBuddyExecutable=$taskPlan.workbuddyExecutable
Push-Location $taskRoot
try {
 foreach($taskStep in @(@('ci'),@('run','build'),@('run','package'))){& npm.cmd @taskStep;if($LASTEXITCODE -ne 0){throw 'Dependency/build/package step failed'}}
 if($TraeExecutable){& node (Join-Path $PSScriptRoot 'install.mjs') $TraeExecutable;if($LASTEXITCODE -ne 0){throw 'TRAE desktop installation failed'}}
 if($WorkBuddyExecutable){& node (Join-Path $PSScriptRoot 'install-workbuddy.mjs') $WorkBuddyExecutable;if($LASTEXITCODE -ne 0){throw 'WorkBuddy installation failed'}}
 $taskEntry=$taskPlan.mcpEntry
 if(!$taskPlan.mcpExists){& codex mcp add trae-gateway -- (Get-Command node.exe).Source $taskEntry;if($LASTEXITCODE -ne 0){throw 'Codex MCP registration failed'}}
 $taskSkill=$taskPlan.skillDirectory
 if(Test-Path -LiteralPath $taskSkill){$taskOldSkill=Join-Path $taskSkill 'SKILL.md';if((Test-Path -LiteralPath $taskOldSkill) -and (Get-Content -LiteralPath $taskOldSkill -Raw) -ne (Get-Content -LiteralPath (Join-Path $taskRoot 'skills\trae-executor\SKILL.md') -Raw)){Copy-Item -LiteralPath $taskOldSkill -Destination ($taskOldSkill+'.backup-'+[DateTimeOffset]::UtcNow.ToUnixTimeSeconds())}}
 New-Item -ItemType Directory -Path $taskSkill -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $taskRoot 'skills\trae-executor\SKILL.md') -Destination (Join-Path $taskSkill 'SKILL.md')
 $taskAgentSkill=Join-Path $taskPlan.codexRoot 'skills\agent-executor';New-Item -ItemType Directory -Path $taskAgentSkill -Force|Out-Null
 $taskAgentFile=Join-Path $taskAgentSkill 'SKILL.md'
 if(Test-Path -LiteralPath $taskAgentFile){Copy-Item -LiteralPath $taskAgentFile -Destination ($taskAgentFile+'.backup-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}
 Copy-Item -LiteralPath (Join-Path $taskRoot 'skills\agent-executor\SKILL.md') -Destination $taskAgentFile
 & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'manage.ps1') install;if($LASTEXITCODE -ne 0){throw 'Login startup installation failed'}
 Write-Output 'Installed. Start a new Codex conversation and use $agent-executor with TRAE or WorkBuddy. Local address is recorded in data/platform/connection.json.'
} finally {Pop-Location}
