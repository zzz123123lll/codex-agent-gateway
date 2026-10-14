import fs from 'node:fs';import path from 'node:path';
export function createWorkBuddyInstallPlan(root,executable){
 if(!executable||!path.isAbsolute(executable)||!fs.statSync(executable).isFile())throw Error('Pass the actual WorkBuddy executable absolute path');
 if(!fs.existsSync(path.join(path.dirname(executable),'resources','app.asar')))throw Error('WorkBuddy resources/app.asar was not found beside the executable');
 const state=path.join(root,'data','platform'),settingsFile=path.join(state,'settings.json');
 const prior=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
 const settings={...prior,port:prior.port??18493,maxConcurrent:prior.maxConcurrent??1,workbuddy:{...prior.workbuddy,executable,cdpPort:prior.workbuddy?.cdpPort??18491,reportPort:prior.workbuddy?.reportPort??18496}};
 for(const port of [settings.port,settings.workbuddy.cdpPort,settings.workbuddy.reportPort])if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid service or WorkBuddy port');
 if(new Set([settings.port,settings.workbuddy.cdpPort,settings.workbuddy.reportPort]).size!==3)throw Error('Gateway, WorkBuddy CDP and report ports must be different');
 if(!Number.isInteger(settings.maxConcurrent)||settings.maxConcurrent<1||settings.maxConcurrent>16)throw Error('Invalid concurrency');
 return {state,settingsFile,settings};
}
