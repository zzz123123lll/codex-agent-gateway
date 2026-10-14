[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding

function Get-GatewayCodexRoot {
  if($env:CODEX_HOME){
    if(!(Test-Path -LiteralPath $env:CODEX_HOME -PathType Container)){throw 'CODEX_HOME must name an existing directory'}
    return [IO.Path]::GetFullPath($env:CODEX_HOME)
  }
  return Join-Path $env:USERPROFILE '.codex'
}

function Get-GatewaySetupPlan {
  param([string]$Root,[string]$Executable,[string]$WorkBuddyExecutable)
  if(!$IsWindows){throw 'This installer supports Windows TRAE CN / WorkBuddy'}
  if($PSVersionTable.PSVersion.Major -lt 7){throw 'Run this installer with PowerShell 7 (pwsh)'}
  foreach($taskDependency in @('node.exe','npm.cmd','codex','pwsh.exe')){
    if(!(Get-Command $taskDependency -ErrorAction SilentlyContinue)){throw "Missing prerequisite: $taskDependency"}
  }
  $taskVersionText=& node --version
  if($LASTEXITCODE -ne 0){throw 'Cannot run Node.js'}
  $taskVersion=[Version]($taskVersionText.TrimStart('v'))
  if($taskVersion -lt [Version]'22.13.0'){throw 'Node.js 22.13 or newer is required'}
  $taskSettingsPath=Join-Path $Root 'data\platform\settings.json'
  if(Test-Path -LiteralPath $taskSettingsPath){$taskSavedSettings=Get-Content -LiteralPath $taskSettingsPath -Raw|ConvertFrom-Json;if(!$Executable){$Executable=$taskSavedSettings.executable};if(!$WorkBuddyExecutable){$WorkBuddyExecutable=$taskSavedSettings.workbuddy.executable}}
  if(!$Executable -and !$WorkBuddyExecutable){throw 'Pass -TraeExecutable or -WorkBuddyExecutable, or configure their environment variables'}
  if($WorkBuddyExecutable){
    if(!(Test-Path -LiteralPath $WorkBuddyExecutable -PathType Leaf)){throw 'WorkBuddy executable not found'}
    $WorkBuddyExecutable=(Resolve-Path -LiteralPath $WorkBuddyExecutable).Path
    if(!(Test-Path -LiteralPath (Join-Path (Split-Path -Parent $WorkBuddyExecutable) 'resources\app.asar') -PathType Leaf)){throw 'WorkBuddy desktop resources were not found beside its executable'}
    $taskWbPlanScript=Join-Path $Root 'scripts\workbuddy-install-plan.mjs'
    if(!(Test-Path -LiteralPath $taskWbPlanScript -PathType Leaf)){throw 'WorkBuddy installation plan is missing from the package'}
    $taskWbPlanRaw=& node --input-type=module -e 'const m=await import(process.argv[1]); console.log(JSON.stringify(m.createWorkBuddyInstallPlan(process.argv[2],process.argv[3])))' ([Uri]$taskWbPlanScript).AbsoluteUri $Root $WorkBuddyExecutable
    if($LASTEXITCODE -ne 0){throw 'WorkBuddy settings validation failed before installation'}
  }
  if($Executable){
  if(!(Test-Path -LiteralPath $Executable -PathType Leaf)){throw 'Pass -TraeExecutable with your actual TRAE CN executable path'}
  $Executable=(Resolve-Path -LiteralPath $Executable).Path
  $taskLauncher=Join-Path (Split-Path -Parent $Executable) 'bin\trae-cn.cmd'
  if(!(Test-Path -LiteralPath $taskLauncher -PathType Leaf)){throw 'The TRAE CN desktop launcher bin\trae-cn.cmd was not found beside the executable'}
  if(!$env:APPDATA){throw 'APPDATA is required for TRAE CN extension configuration'}
  $taskBridgeFile=Join-Path $env:APPDATA 'Trae CN\User\globalStorage\local-codex.codex-trae-bridge\gateway.json'
  if(Test-Path -LiteralPath $taskBridgeFile){
    $taskBridge=Get-Content -LiteralPath $taskBridgeFile -Raw|ConvertFrom-Json
    if($taskBridge.stateDirectory -ne (Join-Path $Root 'data\platform')){throw 'The desktop bridge belongs to another gateway directory; no installation changes were made'}
  }
  }
  $taskCodexRoot=Get-GatewayCodexRoot
  $taskEntry=Join-Path $Root 'dist\platform\mcp.js'
  $taskRaw=& codex mcp list --json 2>$null
  if($LASTEXITCODE -ne 0){throw 'Cannot read Codex MCP configuration; check the Codex CLI and its configuration before installing'}
  $taskExisting=@($taskRaw|ConvertFrom-Json)|Where-Object {$_.name -eq 'trae-gateway'}
  if($taskExisting){
    $taskArgs=@($taskExisting.transport.args)
    if($taskExisting.transport.type -ne 'stdio' -or $taskArgs.Count -ne 1 -or $taskArgs[0] -ne $taskEntry){throw 'Another trae-gateway configuration exists; no installation changes were made'}
    if($taskExisting.enabled -eq $false){throw 'The existing trae-gateway MCP configuration is disabled; enable it before installing'}
  }
  foreach($taskFile in @('package.json','package-lock.json','skills\trae-executor\SKILL.md','skills\agent-executor\SKILL.md','extension\bridge.cjs')){
    if(!(Test-Path -LiteralPath (Join-Path $Root $taskFile) -PathType Leaf)){throw "Installation package is incomplete: $taskFile"}
  }
  return [PSCustomObject]@{root=$Root;executable=$Executable;workbuddyExecutable=$WorkBuddyExecutable;nodeVersion=$taskVersion.ToString();codexRoot=$taskCodexRoot;mcpEntry=$taskEntry;mcpExists=[bool]$taskExisting;skillDirectory=(Join-Path $taskCodexRoot 'skills\trae-executor');mutationsPerformed=$false}
}
