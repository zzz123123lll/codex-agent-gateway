import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execute=promisify(execFile);
export function sameExecutable(left:string,right:string){
  try{return fs.statSync(left).isFile()&&fs.statSync(right).isFile()&&fs.realpathSync(left).toLowerCase()===fs.realpathSync(right).toLowerCase()}catch{return false}
}
const defaultConfigDirectory=path.join(os.homedir(),'.workbuddy');
function canonicalUnlinkedDirectory(directory:string){
  return path.isAbsolute(directory)&&fs.statSync(directory).isDirectory()&&fs.realpathSync(directory).toLowerCase()===path.resolve(directory).toLowerCase();
}
/** The configured desktop may use its own managed Node, independently of the gateway runtime. */
export function trustedWorkBuddyNode(executable:string,gatewayNode=process.execPath,configDirectory=defaultConfigDirectory){
  try{
    if(sameExecutable(executable,gatewayNode))return true;
    const versions=path.join(configDirectory,'binaries','node','versions');
    for(const directory of [configDirectory,path.join(configDirectory,'binaries'),path.join(configDirectory,'binaries','node'),versions])if(!canonicalUnlinkedDirectory(directory))return false;
    const actual=fs.realpathSync(executable),relative=path.relative(versions,actual),segments=relative.split(path.sep);
    const [versionName,fileName]=segments;
    if(actual.toLowerCase()!==path.resolve(executable).toLowerCase()||segments.length!==2||typeof versionName!=='string'||typeof fileName!=='string'||!/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/.test(versionName)||fileName.toLowerCase()!=='node.exe')return false;
    const version=path.join(versions,versionName),expected=path.join(version,fileName);
    return canonicalUnlinkedDirectory(version)&&fs.statSync(actual).isFile()&&actual.toLowerCase()===path.resolve(expected).toLowerCase()&&fs.realpathSync(expected).toLowerCase()===path.resolve(expected).toLowerCase();
  }catch{return false}
}
export function verifyWorkBuddyLineage(lineage:any,actorPid:number,desktopPid:number,executable:string,gatewayNode=process.execPath,configDirectory=defaultConfigDirectory){
  return Number.isSafeInteger(actorPid)&&actorPid>0&&Number.isSafeInteger(desktopPid)&&desktopPid>0&&actorPid!==desktopPid&&
    Array.isArray(lineage)&&lineage[0]?.pid===actorPid&&typeof lineage[0]?.exe==='string'&&trustedWorkBuddyNode(lineage[0].exe,gatewayNode,configDirectory)&&
    lineage.slice(1).some((row:any)=>row.pid===desktopPid&&typeof row.exe==='string'&&sameExecutable(row.exe,executable));
}
export async function windowsQuery(script:string):Promise<any> {
  if(process.platform!=='win32')throw new Error('The native adapter requires Windows');
  const {stdout}=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024});
  return JSON.parse(stdout);
}
export async function listenerOwner(executable:string,port:number):Promise<number> {
  if(!path.isAbsolute(executable)||!fs.statSync(executable).isFile()||!fs.existsSync(path.join(path.dirname(executable),'resources','app.asar')))throw new Error('An installed WorkBuddy executable is required');
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid native port');
  const listeners=await windowsQuery(`$r=@();Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue|ForEach-Object {$v=Get-CimInstance Win32_Process -Filter ('ProcessId='+$_.OwningProcess);$r+=@{address=$_.LocalAddress;pid=[int]$_.OwningProcess;exe=$v.ExecutablePath}};ConvertTo-Json -InputObject @($r) -Compress`);
  if(!Array.isArray(listeners)||!listeners.length||listeners.some(row=>row.address!=='127.0.0.1'||typeof row.exe!=='string'||!sameExecutable(row.exe,executable))||new Set(listeners.map(row=>row.pid)).size!==1)throw new Error('Native listener is not exclusively owned by the configured loopback desktop');
  return listeners[0].pid;
}
export async function verifyWorkBuddyActor(actorPid:number,desktopPid:number,executable:string):Promise<boolean> {
  if(!Number.isSafeInteger(actorPid)||actorPid<=0||!Number.isSafeInteger(desktopPid)||desktopPid<=0||actorPid===desktopPid)return false;
  try{
    const lineage=await windowsQuery(`$p=${actorPid};$r=@();for($i=0;$i -lt 40 -and $p -gt 0;$i++){$v=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p);if(!$v){break};$r+=@{pid=[int]$v.ProcessId;exe=$v.ExecutablePath};if($p -eq [int]$v.ParentProcessId){break};$p=[int]$v.ParentProcessId};ConvertTo-Json -InputObject @($r) -Compress`);
    return verifyWorkBuddyLineage(lineage,actorPid,desktopPid,executable);
  }catch{return false}
}
