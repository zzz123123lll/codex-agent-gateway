import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import {TraeDesktop} from '../desktop.js';
import {TraeProvider} from '../platform/trae.js';
import {WorkBuddyProvider} from '../platform/workbuddy.js';
import {WindowsWorkBuddyDriver} from '../platform/workbuddy-native.js';
import {HubStore} from '../platform/store.js';
import {HubEngine} from '../platform/engine.js';
import {createHubServer} from '../platform/http.js';
import type {AgentProvider} from '../platform/contracts.js';
import {acquireServiceLock,atomicJson,ensureToken,packageVersion,projectRoot,readConfiguration} from './settings.js';

async function listen(server:http.Server,port:number){await new Promise<void>((resolve,reject)=>{const failed=(error:Error)=>{server.off('listening',ready);reject(error);};const ready=()=>{server.off('error',failed);resolve();};server.once('error',failed);server.once('listening',ready);server.listen(port,'127.0.0.1');});}
export async function startRuntime(directory:string,signal?:AbortSignal){
 const configuration=readConfiguration(directory),lock=acquireServiceLock(directory),connectionFile=path.join(directory,'connection.json');
 let store:HubStore|undefined,engine:HubEngine|undefined,server:http.Server|undefined,workbuddy:WorkBuddyProvider|undefined,driver:WindowsWorkBuddyDriver|undefined;
 let timer:NodeJS.Timeout|undefined,inFlight:Promise<unknown>|undefined,stopping=false,closing:Promise<void>|undefined;
 const aborted=()=>{if(signal?.aborted)throw Error('Service startup cancelled');};
 const close=()=>closing??= (async()=>{
  stopping=true;if(timer)clearInterval(timer);
  if(server){const stopped=new Promise<void>((resolve)=>{if(server!.listening)server!.close(()=>resolve());else resolve();});server.closeAllConnections();await stopped;}
  if(inFlight)await inFlight.catch(()=>{});
  if(engine)await engine.exclusive(async()=>{});
  try{await workbuddy?.close();}finally{try{await driver?.close();}finally{try{store?.close();}finally{
   try{if(JSON.parse(fs.readFileSync(connectionFile,'utf8')).owner===lock.owner)fs.unlinkSync(connectionFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')console.error('Connection cleanup failed');}
   lock.release();
  }}}
 })();
 try{
  // A stale connection is never advertised during startup or after its failure.
  fs.rmSync(connectionFile,{force:true});const {file:tokenFile,token}=ensureToken(directory);aborted();
  const providers:AgentProvider[]=[];
  if(configuration.traeExecutable)providers.push(new TraeProvider(new TraeDesktop(directory,configuration.traeExecutable)));
  if(configuration.workbuddy){const c=configuration.workbuddy;driver=new WindowsWorkBuddyDriver(c.executable,c.cdpPort);workbuddy=new WorkBuddyProvider(directory,c.executable,path.join(projectRoot,'scripts','worker.mjs'),driver,c.reportPort);await workbuddy.start();providers.push(workbuddy);aborted();}
  store=new HubStore(path.join(directory,'hub.sqlite'));engine=new HubEngine(store,providers,directory,configuration.maxConcurrent);server=createHubServer(engine,token);await listen(server,configuration.port);aborted();
  const url='http://127.0.0.1:'+configuration.port,startedAt=new Date().toISOString();atomicJson(connectionFile,{url,tokenFile,pid:process.pid,owner:lock.owner,version:packageVersion,startedAt,updatedAt:startedAt});
  const cycle=()=>{if(stopping||inFlight)return;inFlight=engine!.tick().catch(()=>console.error('Task reconciliation failed; durable attempts are preserved')).finally(()=>{inFlight=undefined;});};
  timer=setInterval(cycle,500);cycle();server.on('error',()=>{console.error('Local server failed');void close().then(()=>{process.exitCode=1;});});
  return {url,engine,store,server,close};
 }catch(error){await close();throw error;}
}
