import fs from 'node:fs';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';import path from 'node:path';
import {createWorkBuddyInstallPlan} from './workbuddy-install-plan.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));const plan=createWorkBuddyInstallPlan(root,process.argv[2]??process.env.WORKBUDDY_EXECUTABLE);
fs.mkdirSync(plan.state,{recursive:true});
const acl=spawnSync('icacls.exe',[path.join(root,'data'),'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,'SYSTEM:(OI)(CI)F','/Q'],{stdio:'pipe',windowsHide:true});if(acl.status!==0)throw Error('Could not restrict private state ACL');
if(fs.existsSync(plan.settingsFile))fs.copyFileSync(plan.settingsFile,plan.settingsFile+'.backup-'+Date.now());
fs.writeFileSync(plan.settingsFile,JSON.stringify(plan.settings));console.log('WorkBuddy configured; existing provider settings preserved');
