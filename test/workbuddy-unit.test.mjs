import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {WORKBUDDY_BRIDGE} from '../dist/platform/workbuddy-native.js';
import {nativeActivity} from '../dist/infrastructure/workbuddy/bridge.js';
import {AttemptJournal,attemptProgress} from '../dist/infrastructure/workbuddy/journal.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkBuddyProvider} from '../dist/platform/workbuddy.js';
import {HubEngine} from '../dist/platform/engine.js';
import {HubStore} from '../dist/platform/store.js';

test('native activity is pessimistic about unknown status and pending native inputs',()=>{
  assert.equal(nativeActivity({status:'terminated'},[],'s','C:\\project').state,'idle');
  assert.equal(nativeActivity({status:'alien'},[],'s','C:\\project').state,'busy');
  assert.equal(nativeActivity({status:'idle',pendingPermissions:[{}]},[],'s','C:\\project').state,'waiting_input');
  assert.equal(nativeActivity({status:'idle'},[{sessionId:'s'}],'s','C:\\project').state,'busy');
  assert.equal(nativeActivity({status:'idle',hasActiveTeamMembers:true},[],'s','C:\\project').state,'busy');
});
test('renderer namespace is isolated and the bridge is syntactically executable',()=>{
  assert.match(WORKBUDDY_BRIDGE,/__codexAgentGatewayV3/);
  assert.doesNotThrow(()=>new vm.Script(WORKBUDDY_BRIDGE));
});
test('old journals retain grants, session bindings, pending occupancy and unknown audit fields',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-journal-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const journal=new AttemptJournal(directory),workspace=path.join(directory,'project');fs.mkdirSync(workspace);
  const id='hub-fixture-round-2';
  fs.writeFileSync(path.join(journal.attempts,id+'.json'),JSON.stringify({id,workspace,sessionId:'original',wakeId:'wake-run-original',status:'reserved',receipt:false,lease:'a'.repeat(64),desktopPid:5,progress:'legacy actual progress',recovery:{note:'history'}}));
  fs.writeFileSync(path.join(journal.attempts,id+'.grant.json'),JSON.stringify({id,url:'http://127.0.0.1:9',lease:'a'.repeat(64),desktopPid:5,executable:'desktop'}));
  const attempt=journal.get(id);assert.equal(attempt.holdsCapacity,true);assert.equal(attempt.status,'dispatching');assert.equal(attempt.round,2);assert.equal(attempt.sessionId,'original');
  assert.equal(journal.all().length,1);assert.equal(journal.grant(id).desktopPid,5);assert.equal(attemptProgress(attempt)[0].text,'legacy actual progress');assert.match(attemptProgress(attempt)[0].key,/hub-fixture-round-2:progress:[a-f0-9]{64}/);journal.save(attempt);assert.equal(JSON.parse(fs.readFileSync(path.join(journal.attempts,id+'.json'))).recovery.note,'history');assert.equal(JSON.parse(fs.readFileSync(path.join(journal.attempts,id+'.json'))).progress,'legacy actual progress');
  journal.bind(workspace,'original');assert.equal(journal.binding(workspace),'original');
});

async function providerFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-native-restart-'));
  const workspace=path.join(directory,'project');fs.mkdirSync(workspace);
  const driver={state:'idle',ack:true,sends:[],cancels:0,failSend:false,sessionId:undefined,
    async owner(){return 43},async create(cwd,sid){this.sessionId=sid;return sid},
    async inspect(){return {state:this.state,workspace}},async receipt(sid,wake){return this.ack&&this.sends.some(value=>value.sid===sid&&value.wake===wake)},
    async send(sid,wake,prompt){this.sends.push({sid,wake,prompt});this.state='busy';if(this.failSend)throw Error('transport lost after submission')},async cancel(){this.cancels++},async close(){}
  };
  const makeProvider=()=>new WorkBuddyProvider(directory,path.join(directory,'WorkBuddy.exe'),path.join(directory,"helper ' $(echo unsafe).mjs"),driver,0,async pid=>pid===42);
  const provider=makeProvider();await provider.start();const providers=[provider];
  t.after(async()=>{for(const value of providers)await value.close();fs.rmSync(directory,{recursive:true,force:true})});
  const now=new Date().toISOString(),id='hub-'+randomUUID();
  const run={id,providerTaskId:id,round:1,workspace,resultFile:path.join(directory,'output.json'),input:{provider:'workbuddy',task:'execute',workspace,output:'text',constraints:[],timeoutSeconds:1800},status:'dispatching',review:'pending',holdsCapacity:true,createdAt:now,updatedAt:now,deadline:new Date(Date.now()+1800000).toISOString(),usage:{credits:null,source:'unavailable'}};
  const grant=()=>JSON.parse(fs.readFileSync(path.join(provider.attempts,id+'-round-1.grant.json'),'utf8'));
  return {provider,run,grant,driver,async restart(){await provider.close();const restarted=makeProvider();providers.push(restarted);await restarted.start();return restarted}};
}
test('connection loss after sending reserves the original session and never replays on retry or restart',async t=>{
  const f=await providerFixture(t);f.driver.failSend=true;f.driver.ack=false;
  await assert.rejects(f.provider.submit(f.run),/transport lost/);const original=f.grant();
  await assert.rejects(f.provider.submit(f.run),/already reserved/);assert.equal(f.driver.sends.length,1);
  const restarted=await f.restart();const current=f.grant();assert.equal(current.id,original.id);assert.equal(current.lease,original.lease);
  let snapshot=await restarted.poll(f.run);assert.equal(snapshot.holdsCapacity,true);assert.equal(snapshot.status,'blocked');
  f.driver.state='idle';await assert.rejects(restarted.submit(f.run));assert.equal(f.driver.sends.length,1);
  await restarted.recover({...f.run,status:'uncertain'},'operator verified stop');snapshot=await restarted.poll(f.run);assert.equal(snapshot.holdsCapacity,false);assert.equal(snapshot.status,'failed');
});
test('simultaneous workspace dispatches issue one native prompt, and helper paths are safely quoted',async t=>{
  const f=await providerFixture(t);const other={...f.run,id:'hub-'+randomUUID(),providerTaskId:'other'};
  const attempts=await Promise.allSettled([f.provider.submit(f.run),f.provider.submit(other)]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);assert.equal(f.driver.sends.length,1);
  assert.match(f.driver.sends[0].prompt,/helper '' \$\(echo unsafe\)\.mjs'/);
});
test('HubEngine repeated cancellation refreshes preserve three-idle proof and dispatch the next queued task',async t=>{
  const f=await providerFixture(t);
  const store=new HubStore(path.join(f.provider.directory,'cancel-regression.db'));
  try {const engine=new HubEngine(store,[f.provider],f.provider.directory,1);
  const first=engine.submit({provider:'workbuddy',task:'first',workspace:f.run.workspace}).run;
  const second=engine.submit({provider:'workbuddy',task:'second',workspace:f.run.workspace}).run;
  await engine.tick();assert.equal(engine.get(second.id).status,'queued');
  await engine.cancel(first.id);assert.equal(f.driver.cancels,1);assert.equal(engine.get(first.id).holdsCapacity,true);
  f.driver.state='idle';await engine.tick();await engine.tick();assert.equal(engine.get(first.id).holdsCapacity,true);
  await engine.tick();assert.equal(engine.get(first.id).status,'cancelled');assert.equal(engine.get(first.id).holdsCapacity,false);
  assert.equal(f.driver.cancels,1);assert.equal(f.driver.sends.length,2);assert.notEqual(engine.get(second.id).status,'queued');
  }finally{store.close()}
});
test('a proven pre-send failure can be explicitly retried in a new round without requiring a nonexistent session',async t=>{
  const f=await providerFixture(t),owner=f.driver.owner;f.driver.owner=async()=>{throw Error('desktop not configured')};
  const store=new HubStore(path.join(f.provider.directory,'retry-regression.db'));
  try{
    const engine=new HubEngine(store,[f.provider],f.provider.directory,1);
    const first=engine.submit({provider:'workbuddy',task:'first',workspace:f.run.workspace}).run;await engine.tick();
    assert.equal(engine.get(first.id).error.code,'DISPATCH_NOT_SENT');assert.equal(f.driver.sends.length,0);
    f.driver.owner=owner;await engine.rework(first.id,'native desktop is now ready');await engine.tick();
    assert.equal(engine.get(first.id).round,2);assert.equal(engine.get(first.id).status,'running');assert.equal(f.driver.sends.length,1);
  }finally{store.close()}
});
test('legacy adapter create without a return, boolean send and synchronous close remain callable',async t=>{
  const f=await providerFixture(t),create=f.driver.create,send=f.driver.send;
  f.driver.create=async function(...args){await create.apply(this,args)};
  f.driver.send=async function(...args){await send.apply(this,args);return true};f.driver.close=()=>{};
  await f.provider.submit(f.run);const snapshot=await f.provider.poll(f.run);
  assert.equal(snapshot.status,'running');assert.equal(snapshot.holdsCapacity,true);assert.equal(f.driver.sends.length,1);
});
test('a disconnected renderer bridge installs a fresh transport and ignores delayed prior-generation replies',async t=>{
  const ports=[],requests=[];let cancelledRequest,freshWorkspaceRequest;
  const browser={postMessage(_message,_target,transfer){
    const remote=transfer[0],generation=ports.length;ports.push(remote);
    remote.onmessage=event=>{
      if(event.data.kind!=='message')return;
      const request=JSON.parse(event.data.json);requests.push(request);
      if(request.channel==='session:cancel'){cancelledRequest=request;return}
      if(generation>0&&request.channel==='workspace:initialize'){freshWorkspaceRequest={request,remote};return}
      remote.postMessage({kind:'message',json:JSON.stringify({id:request.id,type:'response',channel:request.channel,result:request.channel==='session:create'?{sessionId:'original'}:{}})});
    };
    remote.postMessage({kind:'open'});
  }};
  const context=vm.createContext({window:browser,MessageChannel,crypto:globalThis.crypto,setTimeout,clearTimeout});
  const source=new vm.Script(WORKBUDDY_BRIDGE);const first=source.runInContext(context);
  t.after(()=>{browser.__codexAgentGatewayV3.close();for(const port of ports)port.close()});
  await first.create('C:\\fixture','original');
  const cancellation=first.cancel('original');const rejection=assert.rejects(cancellation,/disconnected/);
  async function until(condition){const end=Date.now()+1000;while(!condition()){if(Date.now()>end)throw Error('mock transport did not progress');await new Promise(resolve=>setTimeout(resolve,5))}}
  await until(()=>cancelledRequest);ports[0].postMessage({kind:'close'});await rejection;
  const second=source.runInContext(context);assert.notEqual(second,first);assert.equal(ports.length,2);
  let completed=false;const create=second.create('C:\\fixture','original').then(value=>{completed=true;return value});
  await until(()=>freshWorkspaceRequest);assert.notEqual(freshWorkspaceRequest.request.id,cancelledRequest.id);
  freshWorkspaceRequest.remote.postMessage({kind:'message',json:JSON.stringify({id:cancelledRequest.id,type:'response',channel:'session:cancel',result:{}})});
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(completed,false,'stale reply does not resolve a new operation');
  freshWorkspaceRequest.remote.postMessage({kind:'message',json:JSON.stringify({id:freshWorkspaceRequest.request.id,type:'response',channel:'workspace:initialize',result:{}})});
  assert.equal(await create,'original');assert.equal(requests.filter(request=>request.channel==='workspace:initialize').length,2);
});
test('captured WorkBuddy 5.7.7 response envelope shape drives RPC, and response errors propagate',async t=>{
  // Envelope keys/type copied from sanitized native-frame-shapes.json; values below are fixture data.
  const capturedShape={id:'agent-v3-probe-192',type:'response',channel:'session:get',result:{}};
  const frames=[],ports=[];let staleClosed=0,rejectCancel=false;
  const browser={__codexAgentGatewayV3:{connected:()=>true,close:()=>{staleClosed++}},postMessage(_message,_target,transfer){
    const remote=transfer[0];ports.push(remote);
    remote.onmessage=event=>{
      if(event.data.kind!=='message')return;
      const request=JSON.parse(event.data.json),native={sessionId:'observed-session',cwd:'C:\\fixture',status:'terminated'};
      let result={};if(['session:create','session:get','session:load'].includes(request.channel))result=native;if(request.channel==='daemon:getActiveSessions')result=[];
      const envelope={...capturedShape,id:request.id,channel:request.channel,result};
      if(request.channel==='session:cancel'&&rejectCancel){delete envelope.result;envelope.error={message:'native response refusal'}}
      frames.push(envelope);remote.postMessage({sessionId:'transport-fixture',kind:'message',json:JSON.stringify(envelope)});
    };remote.postMessage({sessionId:'transport-fixture',kind:'open'});
  }};
  const context=vm.createContext({window:browser,MessageChannel,crypto:globalThis.crypto,setTimeout,clearTimeout});
  const script=new vm.Script(WORKBUDDY_BRIDGE),bridge=script.runInContext(context);
  t.after(()=>{bridge.close();for(const port of ports)port.close()});
  assert.equal(staleClosed,1,'updating only this gateway namespace replaces its stale parser');
  assert.equal(script.runInContext(context),bridge,'current connected revision is reused');
  assert.equal(await bridge.create('C:\\fixture','observed-session'),'observed-session');
  assert.equal((await bridge.inspect('observed-session')).state,'idle');
  assert.deepEqual(Object.keys(frames.find(frame=>frame.channel==='session:get')),Object.keys(capturedShape));
  rejectCancel=true;await assert.rejects(bridge.cancel('observed-session'),/native response refusal/);
});
