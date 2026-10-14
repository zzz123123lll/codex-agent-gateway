import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../',import.meta.url));
export const packageVersion = JSON.parse(fs.readFileSync(path.join(projectRoot,'package.json'),'utf8')).version as string;
export function stateDirectory(env:NodeJS.ProcessEnv=process.env){return path.resolve(env.AGENT_HUB_STATE_DIR || path.join(projectRoot,'data','platform'));}
export interface Configuration {port:number;maxConcurrent:number;traeExecutable?:string;workbuddy?:{executable:string;cdpPort:number;reportPort:number}}
function integer(value:unknown,fallback:number,name:string,max=65535){const number=value===undefined?fallback:value;if(typeof number!=='number'||!Number.isInteger(number)||number<1||number>max)throw Error('Invalid '+name);return number;}
function environmentInteger(value:string|undefined,name:string){if(value===undefined||value==='')return undefined;if(!/^\d+$/.test(value))throw Error('Invalid '+name);return Number(value);}
export function readConfiguration(directory:string,env:NodeJS.ProcessEnv=process.env):Configuration{
 let settings:Record<string,unknown>={};
 try{settings=JSON.parse(fs.readFileSync(path.join(directory,'settings.json'),'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('Invalid service settings');}
 if(!settings||Array.isArray(settings)||typeof settings!=='object')throw Error('Invalid service settings');
 const savedPort=integer(settings.port,18493,'port');
 const port=integer(environmentInteger(env.AGENT_HUB_PORT,'AGENT_HUB_PORT'),savedPort,'port');
 const savedConcurrency=integer(settings.maxConcurrent,1,'maxConcurrent',16);
 const maxConcurrent=integer(environmentInteger(env.AGENT_HUB_MAX_CONCURRENT,'AGENT_HUB_MAX_CONCURRENT'),savedConcurrency,'maxConcurrent',16);
 const wb=settings.workbuddy;
 if(wb!==undefined&&(!wb||typeof wb!=='object'||Array.isArray(wb)))throw Error('Invalid WorkBuddy settings');
 const workbuddy=wb as Record<string,unknown>|undefined;
 const cdpPort=integer(workbuddy?.cdpPort,18491,'WorkBuddy CDP port');
 const reportPort=integer(workbuddy?.reportPort,18496,'WorkBuddy report port');
 if(new Set([port,cdpPort,reportPort]).size!==3)throw Error('Service, CDP and report ports must differ');
 const exe=env.WORKBUDDY_EXECUTABLE || workbuddy?.executable;
 const trae=env.TRAE_EXECUTABLE || settings.executable;
 if(exe!==undefined&&typeof exe!=='string'||trae!==undefined&&typeof trae!=='string')throw Error('Invalid desktop executable');
 return {port,maxConcurrent,...(trae?{traeExecutable:trae}:{}),...(exe?{workbuddy:{executable:exe as string,cdpPort,reportPort}}:{})};
}
export function atomicJson(file:string,value:unknown){
 fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+crypto.randomUUID()+'.tmp';
 try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);}finally{try{fs.unlinkSync(temporary);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
function living(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}
export function acquireServiceLock(directory:string){
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'service.lock'),owner=crypto.randomUUID();
 for(let attempt=0;attempt<3;attempt++){
  try{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,owner,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {owner,release(){try{if(JSON.parse(fs.readFileSync(file,'utf8')).owner===owner)fs.unlinkSync(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const content=fs.readFileSync(file,'utf8');let prior:{pid?:number};try{prior=JSON.parse(content);}catch{throw Error('Existing service lock cannot be verified');}
  if(!Number.isInteger(prior.pid)||prior.pid!<=0||living(prior.pid!))throw Error('Gateway is already running or its lock cannot be verified');
  // Serialize stale-owner reclamation; contenders never remove a fresh service lock.
  const reclaim=file+'.reclaim';let fd:number;
  try{fd=fs.openSync(reclaim,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('Gateway startup is already running');throw error;}
  try{if(fs.readFileSync(file,'utf8')===content)fs.unlinkSync(file);}finally{fs.closeSync(fd);fs.unlinkSync(reclaim);}
 }
 throw Error('Gateway is already running');
}
export function ensureToken(directory:string){const file=path.join(directory,'api-token');let token:string;try{token=fs.readFileSync(file,'utf8').trim();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;token=crypto.randomBytes(32).toString('hex');fs.writeFileSync(file,token,{flag:'wx',mode:0o600});}if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid local authentication token');return {file,token};}
