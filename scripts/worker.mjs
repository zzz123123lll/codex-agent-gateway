import fs from 'node:fs';import path from 'node:path';import {execFile} from 'node:child_process';
const [action,grantFile,statusOrText,resultFile]=process.argv.slice(2);
if(!['report','blocked','progress'].includes(action)||!grantFile)throw Error('Use report grant.json completed output.json, blocked grant.json reason, or progress grant.json message');
const grant=JSON.parse(fs.readFileSync(grantFile,'utf8')),target=new URL(grant.url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||!/^[a-f0-9]{64}$/.test(grant.lease))throw Error('Invalid local execution grant');
const script=`$p=${process.pid};$r=@();for($i=0;$i -lt 40 -and $p -gt 0;$i++){$v=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p);if(!$v){break};$r+=@{pid=[int]$v.ProcessId;exe=$v.ExecutablePath};if($p -eq [int]$v.ParentProcessId){break};$p=[int]$v.ParentProcessId};ConvertTo-Json -InputObject @($r) -Compress`;
const ancestors=JSON.parse(await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout))));
if(!ancestors.some(p=>p.pid===grant.desktopPid&&p.exe&&path.resolve(p.exe).toLowerCase()===path.resolve(grant.executable).toLowerCase()))throw Error('Helper must be called by the registered execution desktop tools, not Codex or a standalone terminal');
let text=statusOrText,status=action==='blocked'?'blocked':statusOrText;
if(action==='report'){if(!['completed','failed','cancelled'].includes(status)||!resultFile)throw Error('Invalid report arguments');const result=JSON.parse(fs.readFileSync(resultFile,'utf8'));text=result.text;}
if(typeof text!=='string'||!text.trim())throw Error('Actual result or progress text required');
const response=await fetch(grant.url+(action==='progress'?'/progress':'/report'),{method:'POST',headers:{authorization:'Bearer '+grant.lease,'content-type':'application/json'},body:JSON.stringify({id:grant.id,actorPid:process.pid,status,text}),signal:AbortSignal.timeout(25000),redirect:'error'});
const body=await response.json();if(!response.ok)throw Error(body.error??'Report rejected');console.log(JSON.stringify(body));
