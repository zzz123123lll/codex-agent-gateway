import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {HubStore} from '../dist/platform/store.js';
import {HubEngine} from '../dist/platform/engine.js';
const require=createRequire(import.meta.url),source=fs.readFileSync(new URL('../extension/bridge.cjs',import.meta.url),'utf8');
const SEND='icube.chat.sendToAgentNonBlocking',STATUS='icube.chat.getSessionRunningStatus',STOP='icube.chat.stopSession',CURRENT='icube.chat.getCurrentSessionId';
const deadlineError='Deadline passed without both verified report and native stop';
const attemptId=()=> 'hub-'+crypto.randomUUID()+'-round-1';

async function bridgeFixture(t,seed){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-deadline-regression-')),workspace=path.join(dir,'project'),storage=path.join(dir,'extension'),state=path.join(dir,'state');
 for(const folder of [workspace,storage,path.join(state,'results')])fs.mkdirSync(folder,{recursive:true});
 const executable=path.join(dir,'Trae.exe');fs.writeFileSync(path.join(storage,'gateway.json'),JSON.stringify({stateDirectory:state,executable,nodePath:process.execPath,workerPath:'offline fixture only'}));
 const key=crypto.createHash('sha256').update(fs.realpathSync(workspace).toLowerCase()).digest('hex'),journal=path.join(state,'desktop-attempts',key),ticks=[],subscriptions=[],calls=[];
 let native='Running',now=Date.now(),deferredStatus=false,releaseStatus;const seedId=attemptId();
 if(seed){fs.mkdirSync(journal,{recursive:true});fs.writeFileSync(path.join(journal,seedId+'.json'),JSON.stringify({id:seedId,sessionId:'original-session',deadline:new Date(now-1000).toISOString(),...seed}));}
 class Clock extends Date {constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const vscode={version:'offline fixture',workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:workspace}}],isTrusted:true},window:{createOutputChannel:()=>({appendLine(){},dispose(){}}),showInformationMessage(){}},commands:{getCommands:async()=>[SEND,STATUS,STOP,CURRENT],registerCommand:()=>({dispose(){}}),executeCommand:async command=>{calls.push(command);if(command===SEND)return {sessionId:'original-session'};if(command===STATUS){if(native==='OFFLINE')throw Error('Fixture native status unavailable');if(deferredStatus){deferredStatus=false;const captured=native;return new Promise(resolve=>{releaseStatus=()=>resolve(captured)})}return native}if(command===CURRENT)return 'original-session';if(command===STOP){native='WaitingInput';return}}}};
 const mod={exports:{}};
 vm.runInNewContext(source,{require:name=>name==='vscode'?vscode:name==='node:child_process'?{execFile:(_exe,args,_opts,cb)=>{const actor=Number(args.at(-1).match(/\$p=(\d+);/)[1]);cb(null,JSON.stringify([{pid:actor,exe:process.execPath},{pid:process.ppid,exe:executable}]),'')}}:require(name),module:mod,process,Buffer,URL,Date:Clock,setInterval:fn=>{ticks.push(fn);return 1},clearInterval(){},setTimeout,console});
 mod.exports.activate({globalStorageUri:{fsPath:storage},subscriptions});
 t.after(async()=>{for(const item of subscriptions)item.dispose();await new Promise(resolve=>setImmediate(resolve));fs.rmSync(dir,{recursive:true,force:true})});
 const registration=path.join(state,'bridges',key+'.json');for(let i=0;i<100&&!fs.existsSync(registration);i++)await new Promise(resolve=>setTimeout(resolve,5));
 const connection=JSON.parse(fs.readFileSync(registration,'utf8'));
 async function request(route,data,token=connection.token){const response=await fetch(connection.url+route,{method:data?'POST':'GET',headers:{authorization:'Bearer '+token,...(data?{'content-type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});return {status:response.status,body:await response.json()}}
 async function pulse(){for(const fn of ticks)fn();await new Promise(resolve=>setImmediate(resolve));}
 async function start(){const id=attemptId();await request('/submit',{id,prompt:'[CODEX_TRAE_TASK '+id+'] offline task',deadline:new Date(now+1000).toISOString(),resultFile:path.join(state,'results','output.json')});for(let i=0;i<20&&(await request('/attempt/'+id)).body.status!=='running';i++)await new Promise(resolve=>setImmediate(resolve));return id}
 async function report(id,status='completed'){const grant=JSON.parse(fs.readFileSync(path.join(state,'leases',id+'.json'),'utf8'));return request('/report',{id,actorPid:123,status,text:'verified offline report'},grant.lease)}
 return {request,pulse,start,report,calls,seedId,expire(){now+=2000},native(value){native=value},deferNextStatus(){deferredStatus=true},async releaseStatus(){assert.equal(typeof releaseStatus,'function');releaseStatus();releaseStatus=undefined;await new Promise(resolve=>setImmediate(resolve))},read(id){return JSON.parse(fs.readFileSync(path.join(journal,id+'.json'),'utf8'))}};
}

test('TRAE late verified report finishes only after three fresh consecutive idle observations, never resend',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).uncertaintyReason,'deadline');
 assert.equal((await f.report(id)).status,200);f.native('WaitingInput');await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).idleCount,1);await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).idleCount,2);await f.pulse();assert.equal(f.read(id).status,'completed');assert.equal(f.calls.filter(c=>c===SEND).length,1);
});
test('TRAE deadline observation retains occupancy without a report or while native work is active',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();f.native('WaitingInput');for(let i=0;i<5;i++)await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).nativeStatus,'WaitingInput');
 f.native('Running');assert.equal((await f.report(id)).status,200);for(let i=0;i<5;i++)await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).idleCount,0);assert.equal(f.calls.filter(c=>c===SEND).length,1);
});
test('TRAE idle observations before a late report do not replace three fresh post-report confirmations',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();f.native('WaitingInput');for(let i=0;i<5;i++)await f.pulse();assert.equal(f.read(id).status,'uncertain');await f.report(id);await f.pulse();await f.pulse();assert.equal(f.read(id).status,'uncertain');await f.pulse();assert.equal(f.read(id).status,'completed');
});
test('TRAE STATUS requested before report arrival is discarded from the fresh post-report idle sequence',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();f.native('WaitingInput');await f.pulse();await f.pulse();f.deferNextStatus();await f.pulse();assert.equal((await f.report(id)).status,200);assert.equal(f.read(id).idleCount,0);await f.releaseStatus();assert.equal(f.read(id).idleCount,0);assert.equal(f.read(id).nativeStatus,'WaitingInput');await f.pulse();assert.equal(f.read(id).idleCount,1);await f.pulse();assert.equal(f.read(id).status,'uncertain');assert.equal(f.read(id).idleCount,2);await f.pulse();assert.equal(f.read(id).status,'completed');assert.equal(f.calls.filter(command=>command===SEND).length,1);
});
test('TRAE no-report idle observations remain read-only and do not advance fresh confirmation count',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();f.native('WaitingInput');for(let i=0;i<5;i++)await f.pulse();assert.equal(f.read(id).nativeStatus,'WaitingInput');assert.equal(f.read(id).idleCount,0);assert.equal(f.read(id).status,'uncertain');
});
test('TRAE intermittent idle cannot complete a late-reported deadline attempt',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();await f.report(id);f.native('WaitingInput');await f.pulse();await f.pulse();f.native('Running');await f.pulse();assert.equal(f.read(id).idleCount,0);f.native('WaitingInput');await f.pulse();await f.pulse();assert.equal(f.read(id).status,'uncertain');await f.pulse();assert.equal(f.read(id).status,'completed');
});
test('TRAE restart quarantine and non-deadline receipt uncertainty cannot be completed by idle and report',async t=>{
 for(const seed of [{status:'running',error:deadlineError,report:{status:'completed',text:'old verified report'}},{status:'uncertain',uncertaintyReason:'receipt',error:'Native receipt mismatched or uncertain',report:{status:'completed',text:'old verified report'}},{status:'uncertain',error:'Unconfirmed send',report:{status:'completed',text:'unassociated report'}}]){
  const f=await bridgeFixture(t,seed);f.native('WaitingInput');for(let i=0;i<5;i++)await f.pulse();assert.equal(f.read(f.seedId).status,'uncertain');assert.equal(f.calls.filter(c=>c===SEND).length,0);
 }
});
test('TRAE native-status read failure breaks the three-observation idle sequence',async t=>{
 const f=await bridgeFixture(t),id=await f.start();f.expire();await f.pulse();await f.report(id);f.native('WaitingInput');await f.pulse();await f.pulse();f.native('OFFLINE');await f.pulse();assert.equal(f.read(id).idleCount,0);f.native('WaitingInput');await f.pulse();await f.pulse();assert.equal(f.read(id).status,'uncertain');await f.pulse();assert.equal(f.read(id).status,'completed');
});
test('TRAE legacy exact deadline journal remains observable only with known original session',async t=>{
 const f=await bridgeFixture(t,{status:'uncertain',error:deadlineError,report:{status:'completed',text:'previously verified'}});f.native('WaitingInput');await f.pulse();await f.pulse();assert.equal(f.read(f.seedId).status,'uncertain');await f.pulse();assert.equal(f.read(f.seedId).status,'completed');
 const unknown=await bridgeFixture(t,{status:'uncertain',sessionId:undefined,error:deadlineError,report:{status:'completed',text:'unassociated'}});unknown.native('WaitingInput');for(let i=0;i<5;i++)await unknown.pulse();assert.equal(unknown.read(unknown.seedId).status,'uncertain');
});
function engineFixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-queue-retry-')),store=new HubStore(path.join(directory,'hub.sqlite')),calls=[];const provider={id:'trae',label:'offline',capabilities:{},async health(){return {state:'configured',usage:{credits:null,source:'unavailable'}}},async submit(run){calls.push({type:'submit',run})},async poll(run){return {status:'running',holdsCapacity:true,attemptId:run.id+'-round-'+run.round,sessionId:run.sessionId||'native-session',events:[]}},async rework(run){calls.push({type:'rework',run})},async cancel(){},async accept(){}};const engine=new HubEngine(store,[provider],directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})});return {store,engine,calls}}
test('initial undispatched QUEUE_TIMEOUT supports only explicit audited retry, not automatic resend',async t=>{
 const f=engineFixture(t),run=f.engine.submit({task:'initial queue expiry'}).run;f.store.save({...run,deadline:new Date(0).toISOString()});await f.engine.tick();await f.engine.tick();assert.equal(f.calls.length,0);const retry=await f.engine.rework(run.id,'explicitly retry after queue unblock');assert.equal(retry.round,2);assert.equal(retry.previousAttemptId,undefined);assert.equal(f.calls.length,0);assert.equal(f.store.events(run.id).find(e=>e.type==='dispatch_retry').data.previousErrorCode,'QUEUE_TIMEOUT');await f.engine.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0].type,'submit');
});
test('QUEUE_TIMEOUT native identity or held capacity never uses first-dispatch retry; stopped history uses same-session correction',async t=>{
 const f=engineFixture(t);
 for(const fields of [{holdsCapacity:true},{sessionId:'native-without-attempt'}]){const run=f.engine.submit({task:'unsafe retry'}).run;f.store.save({...run,status:'failed',error:{code:'QUEUE_TIMEOUT',message:'expiry'},...fields});await assert.rejects(f.engine.rework(run.id,'retry'),error=>error.code==='RUN_ACTIVE');f.store.save({...f.engine.get(run.id),holdsCapacity:false})}
 const run=f.engine.submit({task:'prior stopped session'}).run,old=run.id+'-round-1';f.store.save({...run,round:2,status:'failed',holdsCapacity:false,attemptId:old,previousAttemptId:old,sessionId:'original-stopped-session',error:{code:'QUEUE_TIMEOUT',message:'round2 was never dispatched'}});const retry=await f.engine.rework(run.id,'continue same original session');assert.equal(retry.round,3);assert.equal(retry.sessionId,'original-stopped-session');assert.equal(retry.previousAttemptId,old);assert.ok(!f.store.events(run.id).some(e=>e.type==='dispatch_retry'));await f.engine.tick();assert.equal(f.calls.at(-1).type,'rework');assert.equal(f.calls.at(-1).run.sessionId,'original-stopped-session');
});
test('QUEUE_TIMEOUT with an existing attempt never takes the identity-free dispatch_retry branch',async t=>{
 const f=engineFixture(t),run=f.engine.submit({task:'has prior native attempt'}).run,attempt=run.id+'-round-1';f.store.save({...run,status:'failed',attemptId:attempt,error:{code:'QUEUE_TIMEOUT',message:'expiry'}});const next=await f.engine.rework(run.id,'explicit correction');assert.equal(next.previousAttemptId,attempt);assert.ok(f.store.events(run.id).some(event=>event.type==='rework'));assert.ok(!f.store.events(run.id).some(event=>event.type==='dispatch_retry'));
});
