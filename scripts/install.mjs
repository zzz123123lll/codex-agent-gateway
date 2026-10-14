import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {createInstallPlan} from './install-plan.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const plan=createInstallPlan(root,process.argv[2]??process.env.TRAE_EXECUTABLE);
const {state,settingsFile,settings,cli,vsix,configDir,configFile,config}=plan;
// Use PowerShell's argument passing; no string-built cmd shell operations.
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const ps=`& ${quote(cli)} --install-extension ${quote(vsix)} --force; exit $LASTEXITCODE`;
const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{stdio:'inherit',windowsHide:true});if(result.status!==0)throw Error('Desktop extension installation failed');
// Restrict state directory to this user and SYSTEM; never print local bearer tokens.
fs.mkdirSync(state,{recursive:true});
const acl=spawnSync('icacls.exe',[path.join(root,'data'),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F','/Q'],{stdio:'pipe',windowsHide:true});if(acl.status!==0)throw Error('Could not restrict private state ACL');
fs.writeFileSync(settingsFile,JSON.stringify(settings));fs.mkdirSync(configDir,{recursive:true});
if(fs.existsSync(configFile))fs.copyFileSync(configFile,configFile+'.backup-'+Date.now());
fs.writeFileSync(configFile,JSON.stringify(config));
console.log('Installed desktop bridge. Gateway will open dedicated project windows as needed.');
