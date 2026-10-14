// Independent Codex-owned acceptance tests for the documented native protocol.
// No live desktop, process discovery, user grants, or model calls are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {WorkBuddyProvider} from '../dist/platform/workbuddy.js';
import {WORKBUDDY_BRIDGE, WindowsWorkBuddyDriver} from '../dist/platform/workbuddy-native.js';

const trustedActorPid=75001, desktopPid=75002;
class NativeFixture {
  state='idle'; acknowledged=true; sessions=[]; sends=[]; cancels=[]; inspections=[];
  async owner(){return desktopPid}
  async create(workspace,sessionId){this.sessions.push({workspace,sessionId});return sessionId}
  async inspect(sessionId){this.inspections.push(sessionId);return {state:this.state,workspace:this.sessions.at(-1)?.workspace,reason:this.state==='waiting_input'?'permission pending':undefined}}
  async receipt(sessionId,wakeId){return this.acknowledged&&this.sends.some(x=>x.sessionId===sessionId&&x.wakeId===wakeId)}
  async send(sessionId,wakeId,prompt){this.sends.push({sessionId,wakeId,prompt});this.state='busy'}
  async cancel(sessionId){this.cancels.push(sessionId)}
  async close(){}
}
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-native-acceptance-'));
  const driver=new NativeFixture(), verified=[];
  const verifyActor=async(actorPid,...context)=>{verified.push({actorPid,context});return actorPid===trustedActorPid};
  const provider=new WorkBuddyProvider(directory,path.join(directory,'WorkBuddy.exe'),path.join(directory,'worker.mjs'),driver,0,verifyActor);
  await provider.start();
  t.after(async()=>{await provider.close();fs.rmSync(directory,{recursive:true,force:true})});
  function makeRun(round=1,previous){
    const id=previous?.id??'hub-'+randomUUID(),workspace=previous?.workspace??path.join(directory,'workspace-'+id);
    const resultFile=path.join(directory,'results',id,'round-'+round,'output.json');
    fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.dirname(resultFile),{recursive:true});
    const now=new Date().toISOString();
    return {id,input:{provider:'workbuddy',task:'Implement a bounded example and self-check it',workspace,output:'text',constraints:[],timeoutSeconds:1800},workspace,providerTaskId:previous?.providerTaskId??id,status:'dispatching',review:'pending',holdsCapacity:true,round,resultFile,sessionId:previous?.sessionId,feedback:round>1?'BUG-001: expected behavior absent; repair and retest':undefined,usage:{credits:null,source:'unavailable'},createdAt:previous?.createdAt??now,updatedAt:now,deadline:new Date(Date.now()+1800000).toISOString()};
  }
  return {directory,provider,driver,verified,makeRun};
}
function findGrants(directory){
  const matches=[];
  function objects(value,file){
    if(!value||typeof value!=='object')return;
    if(typeof value.id==='string'&&typeof value.url==='string'&&typeof value.lease==='string'&&/^[a-f0-9]{64}$/.test(value.lease))matches.push({...value,file});
    for(const nested of Object.values(value))if(nested&&typeof nested==='object')objects(nested,file);
  }
  function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);
    else if(entry.name.endsWith('.json')){try{objects(JSON.parse(fs.readFileSync(file,'utf8')),file)}catch{}}
  }}
  walk(directory);
  return [...new Map(matches.map(g=>[g.id+':'+g.lease,g])).values()];
}
function grantFor(f,previousGrants=[]){
  const previous=new Set(previousGrants.map(g=>g.lease));
  const grants=findGrants(f.directory).filter(g=>!previous.has(g.lease));
  assert.equal(grants.length,1,'each dispatched round issues one unique persisted execution grant');
  const grant=grants[0],url=new URL(grant.url);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.protocol,'http:');assert.notEqual(url.port,'0','ephemeral listener port must be resolved in the worker grant');
  assert.equal(grant.desktopPid,desktopPid);
  return grant;
}
async function post(grant,route,body,lease=grant.lease){
  const response=await fetch(grant.url+route,{method:'POST',headers:{authorization:'Bearer '+lease,'content-type':'application/json'},body:JSON.stringify({id:grant.id,actorPid:trustedActorPid,...body}),signal:AbortSignal.timeout(5000),redirect:'error'});
  const text=await response.text();let data;try{data=JSON.parse(text)}catch{data=text}
  return {status:response.status,ok:response.ok,data};
}
function result(run,text='Real executor outcome'){fs.writeFileSync(run.resultFile,JSON.stringify({text,artifacts:[]}));return text}
function held(snapshot){assert.ok(snapshot,'attempt must remain discoverable');assert.equal(snapshot.holdsCapacity,true);assert.notEqual(snapshot.status,'completed')}
async function finish(f,run,grant){
  const text=result(run);assert.equal((await post(grant,'/report',{status:'completed',text})).ok,true);
  f.driver.state='idle';let snapshot;for(let i=0;i<3;i++)snapshot=await f.provider.poll(run);
  assert.equal(snapshot.status,'completed');assert.equal(snapshot.holdsCapacity,false);return snapshot;
}

test('native completion needs its receipt, authenticated report, and three consecutive idle observations',async t=>{
  const f=await fixture(t),run=f.makeRun();await f.provider.submit(run);const grant=grantFor(f);
  assert.equal(f.driver.sends.length,1);assert.match(f.driver.sends[0].prompt,/CODEX_QUEUE_WAKE/);
  f.driver.state='idle';for(let i=0;i<3;i++)held(await f.provider.poll(run));
  f.driver.state='busy';held(await f.provider.poll(run));
  const text=result(run);assert.equal((await post(grant,'/report',{status:'completed',text})).ok,true);
  held(await f.provider.poll(run));f.driver.state='idle';
  held(await f.provider.poll(run));held(await f.provider.poll(run));
  const completed=await f.provider.poll(run);assert.equal(completed.status,'completed');assert.equal(completed.holdsCapacity,false);
  assert.ok(completed.sessionId);assert.ok(completed.attemptId);assert.equal(completed.accepted,undefined,'an executor cannot grant supervisor acceptance');
});

test('a missing native receipt cannot be replaced by a worker success report or idle observations',async t=>{
  const f=await fixture(t),run=f.makeRun();f.driver.acknowledged=false;
  try{await f.provider.submit(run)}catch{}
  const grant=grantFor(f);assert.equal(f.driver.sends.length,1);
  assert.equal((await post(grant,'/report',{status:'completed',text:result(run)})).ok,true);
  f.driver.state='idle';for(let i=0;i<4;i++)held(await f.provider.poll(run));
  assert.equal(f.driver.sends.length,1,'receipt reconciliation must never resend the prompt');
});

test('forged grants and unrelated actor processes are rejected; terminal reports are idempotent and immutable',async t=>{
  const f=await fixture(t),run=f.makeRun();await f.provider.submit(run);const grant=grantFor(f),text=result(run);
  assert.equal((await post(grant,'/report',{status:'completed',text},'f'.repeat(64))).ok,false);
  assert.equal((await post(grant,'/report',{status:'completed',text,actorPid:trustedActorPid+100})).ok,false);
  assert.ok(f.verified.some(x=>x.actorPid===trustedActorPid+100),'injected process verifier must receive the submitted actor PID');
  f.driver.state='idle';for(let i=0;i<3;i++)held(await f.provider.poll(run));f.driver.state='busy';held(await f.provider.poll(run));
  assert.equal((await post(grant,'/report',{status:'completed',text})).ok,true);
  assert.equal((await post(grant,'/report',{status:'completed',text})).ok,true);
  assert.equal((await post(grant,'/report',{status:'failed',text:'different terminal outcome'})).status,409);
  assert.equal((await post(grant,'/progress',{text:'work after terminal report'})).ok,false);
});

test('an interrupted idle sequence cannot close an executing or approval-waiting native task',async t=>{
  const f=await fixture(t),run=f.makeRun();await f.provider.submit(run);const grant=grantFor(f);
  assert.equal((await post(grant,'/report',{status:'completed',text:result(run)})).ok,true);
  f.driver.state='idle';held(await f.provider.poll(run));held(await f.provider.poll(run));
  f.driver.state='waiting_input';held(await f.provider.poll(run));
  f.driver.state='idle';held(await f.provider.poll(run));held(await f.provider.poll(run));
  assert.equal((await f.provider.poll(run)).holdsCapacity,false);
});

test('rework uses the same native session and a fresh round grant; old success cannot complete the new round',async t=>{
  const f=await fixture(t),first=f.makeRun();await f.provider.submit(first);const firstGrant=grantFor(f);
  const finished=await finish(f,first,firstGrant),second=f.makeRun(2,{...first,...finished});
  const before=findGrants(f.directory);f.driver.state='idle';await f.provider.rework(second);const secondGrant=grantFor(f,before);
  assert.notEqual(secondGrant.id,firstGrant.id);assert.notEqual(secondGrant.lease,firstGrant.lease);
  assert.equal(f.driver.sends.length,2);assert.equal(f.driver.sends[1].sessionId,finished.sessionId);assert.notEqual(f.driver.sends[1].wakeId,f.driver.sends[0].wakeId);
  assert.match(f.driver.sends[1].prompt,/BUG-001/);assert.equal((await post(firstGrant,'/report',{status:'completed',text:'Real executor outcome'})).ok,true);
  f.driver.state='idle';for(let i=0;i<3;i++)held(await f.provider.poll(second));f.driver.state='busy';held(await f.provider.poll(second));
  const repaired=await finish(f,second,secondGrant);assert.equal(repaired.sessionId,finished.sessionId);assert.notEqual(repaired.attemptId,finished.attemptId);
});

test('cancel retains occupancy until native stop; checked recovery rejects a busy session',async t=>{
  const f=await fixture(t),run=f.makeRun();await f.provider.submit(run);grantFor(f);
  await f.provider.cancel(run);assert.equal(f.driver.cancels.length,1);held(await f.provider.poll(run));
  const blocked={...run,status:'blocked',holdsCapacity:true};
  await assert.rejects(f.provider.recover(blocked,'checked by supervisor while still busy'));
  f.driver.state='idle';await f.provider.recover(blocked,'verified native stop; abandon this interrupted attempt');
  const ended=await f.provider.poll(run);assert.equal(ended.holdsCapacity,false);assert.ok(['cancelled','failed','blocked'].includes(ended.status));assert.notEqual(ended.status,'completed');
  assert.equal(f.driver.sends.length,1,'recovery is a release operation, not another dispatch');
});

test('worker reports reject oversized text and unsupported statuses without altering the attempt',async t=>{
  const f=await fixture(t),run=f.makeRun();await f.provider.submit(run);const grant=grantFor(f);
  for(const body of [{status:'completed',text:''},{status:'completed',text:'x'.repeat(60001)},{status:'accepted',text:'self accepted'},{status:'completed',text:'x'.repeat(140000)}])assert.equal((await post(grant,'/report',body)).ok,false);
  held(await f.provider.poll(run));await finish(f,run,grant);
});

test('the native bridge is valid executable JavaScript and the Windows driver remains a callable adapter',()=>{
  assert.equal(typeof WORKBUDDY_BRIDGE,'string');assert.ok(WORKBUDDY_BRIDGE.length>0);
  assert.doesNotThrow(()=>new vm.Script(WORKBUDDY_BRIDGE,{filename:'workbuddy-bridge.js'}));
  assert.equal(typeof WindowsWorkBuddyDriver,'function');
  for(const method of ['owner','create','inspect','receipt','send','cancel','close'])assert.equal(typeof WindowsWorkBuddyDriver.prototype[method],'function',method+' native adapter interface');
});

test('native bridge performs real MessageChannel RPC and preserves the wake receipt identity',async t=>{
  const frames=[],sid='native-fixture-session',cwd='C:\\fixture\\project';let failCancel=false;
  class Port {
    handlers=[];onmessage=null;closed=false;
    postMessage(data){queueMicrotask(()=>{if(this.peer.closed)return;const event={data};this.peer.onmessage?.(event);for(const handler of this.peer.handlers)handler(event)})}
    addEventListener(type,fn){if(type==='message')this.handlers.push(fn)}
    removeEventListener(type,fn){if(type==='message')this.handlers=this.handlers.filter(x=>x!==fn)}
    start(){}
    close(){this.closed=true}
  }
  class Channel {constructor(){this.port1=new Port();this.port2=new Port();this.port1.peer=this.port2;this.port2.peer=this.port1}}
  const ports=[];
  const browser={postMessage(message,target,transfer){
    assert.equal(message.type,'workbuddy:open-local-daemon-transport-port');assert.equal(message.target.transportType,'local');assert.equal(transfer.length,1);
    const remote=transfer[0];ports.push(remote,remote.peer);
    remote.onmessage=event=>{
      if(event.data.kind!=='message')return;
      const request=typeof event.data.json==='string'?JSON.parse(event.data.json):event.data.json;
      frames.push(request);assert.equal(request.type,'request');assert.ok(request.id);assert.ok(Array.isArray(request.args));
      const reply=value=>remote.postMessage({kind:'message',json:typeof event.data.json==='string'?JSON.stringify(value):value});
      if(request.channel==='session:cancel'&&failCancel){reply({id:request.id,type:'error',error:{message:'fixture cancellation rejected'}});return}
      const native={sessionId:sid,cwd,workspace:cwd,status:'idle',state:'idle',pendingInputKind:null,pendingPermissions:[],pendingQuestions:[],pendingElicitations:[],isProcessing:false,stopRequested:false,hasActiveTeamMembers:false,hasActiveToolCalls:false};
      let result={};
      if(request.channel==='session:create')result=native;
      if(request.channel==='session:get'||request.channel==='session:load')result=native;
      if(request.channel==='daemon:getActiveSessions')result=[];
      reply({id:request.id,type:'result',result});
      if(request.channel==='session:sendMessage'){
        const [sessionId,contents,metadata]=request.args;
        reply({type:'event',channel:'session:event:'+sessionId,result:{sessionId,update:{sessionUpdate:'user_message_chunk',content:contents[0]},_meta:metadata}});
      }
    };
    remote.postMessage({kind:'open'});
  }};
  browser.window=browser;browser.self=browser;
  const context=vm.createContext({window:browser,self:browser,MessageChannel:Channel,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,console,URL,Promise,crypto:globalThis.crypto});
  t.after(()=>{for(const port of ports)port.close()});
  const expression=new vm.Script(WORKBUDDY_BRIDGE,{filename:'workbuddy-bridge.js'}).runInContext(context,{timeout:1000});
  const resolved=await expression;
  const candidates=[resolved,...Object.values(browser),...Object.values(context)];
  const bridge=candidates.find(value=>value&&['create','inspect','receipt','send','cancel'].every(method=>typeof value[method]==='function'));
  assert.ok(bridge,'evaluating the bridge publishes the driver-compatible callable browser adapter');
  await bridge.create(cwd,sid);
  const created=frames.find(f=>f.channel==='session:create');assert.ok(created);assert.equal(created.args[0].cwd,cwd);assert.equal(created.args[0].sessionId,sid);assert.equal(created.args[0].isPlayground,false);
  assert.equal(frames.find(f=>f.channel==='workspace:initialize')?.args[0].cwd,cwd);
  const inspected=await bridge.inspect(sid);assert.equal(inspected.state,'idle');
  assert.ok(frames.some(f=>f.channel==='daemon:getActiveSessions'));assert.ok(frames.some(f=>f.channel==='session:get'));
  const wake='wake-run-'+randomUUID(),prompt='[CODEX_QUEUE_WAKE '+wake+']\nexecute the authorized fixture';
  await bridge.send(sid,wake,prompt);
  const sent=frames.find(f=>f.channel==='session:sendMessage');assert.equal(sent.args[0],sid);assert.equal(sent.args[1][0].type,'text');assert.equal(sent.args[1][0].text,prompt);
  for(const field of ['requestId','userMessageId','messageRequestId'])assert.equal(sent.args[2]['codebuddy.ai'][field],wake);
  assert.equal(sent.args[2]['codebuddy.ai'].emitSyntheticUserPromptLive,true);
  assert.equal(await bridge.receipt(sid,wake),true);assert.equal(await bridge.receipt(sid,'other-wake'),false);
  await bridge.cancel(sid);assert.equal(frames.find(f=>f.channel==='session:cancel').args[0],sid);
  failCancel=true;await assert.rejects(bridge.cancel(sid),'native RPC errors must propagate rather than claim cancellation');
});
