import fs from 'node:fs';
import path from 'node:path';

export function createInstallPlan(root,executable,env=process.env){
  if(!executable||!path.isAbsolute(executable)||!fs.existsSync(executable)||!fs.statSync(executable).isFile())throw Error('Pass the actual TRAE exe absolute path');
  if(!env.APPDATA)throw Error('APPDATA is required for TRAE CN configuration');
  const cli=path.join(path.dirname(executable),'bin','trae-cn.cmd');if(!fs.existsSync(cli))throw Error('TRAE CN desktop CLI launcher was not found');
  const vsix=path.join(root,'codex-trae-bridge.vsix');if(!fs.existsSync(vsix))throw Error('Run npm run package first');
  const state=path.join(root,'data','platform'),settingsFile=path.join(state,'settings.json');
  const prior=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
  const settings={...prior,executable,port:prior.port??18493,maxConcurrent:prior.maxConcurrent??1};
  if(!Number.isInteger(settings.port)||settings.port<1||settings.port>65535)throw Error('Existing settings contain an invalid service port');
  if(!Number.isInteger(settings.maxConcurrent)||settings.maxConcurrent<1||settings.maxConcurrent>16)throw Error('Existing settings contain invalid concurrency');
  const configDir=path.join(env.APPDATA,'Trae CN','User','globalStorage','local-codex.codex-trae-bridge'),configFile=path.join(configDir,'gateway.json');
  if(fs.existsSync(configFile)){
    const priorConfig=JSON.parse(fs.readFileSync(configFile,'utf8'));
    if(typeof priorConfig.stateDirectory!=='string'||path.resolve(priorConfig.stateDirectory).toLowerCase()!==path.resolve(state).toLowerCase())throw Error('The desktop bridge belongs to another gateway directory; uninstall that integration before moving or replacing it');
  }
  return {root,state,settingsFile,settings,cli,vsix,configDir,configFile,config:{stateDirectory:state,executable,nodePath:process.execPath,workerPath:path.join(root,'scripts','worker.mjs')}};
}
