import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {WORKBUDDY_BRIDGE} from '../dist/platform/workbuddy-native.js';

function fixture(t){
  const ports=[],calls=[],modernCalls=[];
  const f={legacy:{sessionId:'original',cwd:'C:\\fixture',status:'terminated'},
    info:{id:'original',state:'idle',transport:'local',space:{type:'local',cwd:'C:\\fixture'}},pending:undefined,inputs:[],queued:[],active:[],failure:undefined,legacyCancelFailure:undefined,modernCancelFailure:undefined};
  const browser={postMessage(_message,_target,transfer){const remote=transfer[0];ports.push(remote);
    remote.onmessage=event=>{if(event.data.kind!=='message')return;const req=JSON.parse(event.data.json);calls.push(req);
      const result=['session:get','session:create','session:load'].includes(req.channel)?f.legacy:req.channel==='daemon:getActiveSessions'?f.active:{};
      if(req.channel==='session:cancel'&&f.legacyCancelFailure){remote.postMessage({kind:'message',json:JSON.stringify({id:req.id,type:'error',error:{message:f.legacyCancelFailure}})});return;}
      remote.postMessage({kind:'message',json:JSON.stringify({id:req.id,type:'response',result})});};remote.postMessage({kind:'open'});},
    async __wbInvoke(channel,context,...args){modernCalls.push({channel,context,args});
      if(f.failure)return {__wbError:true,message:f.failure,code:4001};
      if(channel==='wb:conversations:get')return {info:f.info};
      if(channel==='wb:conversations:getPendingInfo')return f.pending;
      if(channel==='wb:conversations:inputHistory')return f.inputs;
      if(channel==='wb:conversations:queueItems')return f.queued;
      if(channel==='wb:conversations:create'){f.info={id:args[0].conversationId,state:'idle',transport:'local',space:{type:'local',cwd:args[0].cwd}};return {info:f.info};}
      if(channel==='wb:conversations:sendPrompt'){f.inputs.unshift({requestId:args[2]?.clientRequestId,blocks:args[1]});f.info.state='working';return;}
      if(channel==='wb:conversations:cancel'){if(f.modernCancelFailure)return {__wbError:true,message:f.modernCancelFailure};f.info.state='idle';f.pending=undefined;return;}
      throw Error('Unexpected native method '+channel);
    }};
  const context=vm.createContext({window:browser,MessageChannel,crypto:globalThis.crypto,setTimeout,clearTimeout});
  const bridge=new vm.Script(WORKBUDDY_BRIDGE).runInContext(context);
  t.after(()=>{bridge.close();for(const port of ports)port.close()});return {...f,bridge,calls,modernCalls,source:f};
}
test('GUI pending input is visible when the legacy session has no pending input',async t=>{
  const f=fixture(t);f.source.pending={id:'native-permission',kind:'permission'};
  const state=await f.bridge.inspect('original');assert.equal(state.state,'waiting_input');assert.equal(state.workspace,'C:\\fixture');
});
test('an orphan legacy permission prevents modern dispatch and capacity release',async t=>{
  const f=fixture(t);f.source.legacy.pendingPermissions=[{requestId:'old-permission'}];
  assert.equal((await f.bridge.inspect('original')).state,'waiting_input');
  await assert.rejects(f.bridge.send('original','wake-1','[CODEX_QUEUE_WAKE wake-1]\nexecute'),/idle|pending|busy/i);
  assert.equal(f.modernCalls.filter(x=>x.channel.endsWith(':sendPrompt')).length,0);
  assert.equal(f.calls.filter(x=>x.channel==='session:sendMessage').length,0);
});
test('modern dispatch uses the GUI execution owner and native input history for its receipt',async t=>{
  const f=fixture(t);await f.bridge.inspect('original');
  await f.bridge.send('original','wake-1','[CODEX_QUEUE_WAKE wake-1]\nexecute');
  assert.equal(await f.bridge.receipt('original','wake-1'),true);
  assert.equal(await f.bridge.receipt('original','wake-other'),false);
  const sent=f.modernCalls.filter(x=>x.channel==='wb:conversations:sendPrompt');assert.equal(sent.length,1);
  assert.equal(sent[0].context,undefined);assert.equal(sent[0].args[0],'original');
  assert.deepEqual(Object.keys(sent[0].args[2]),['clientRequestId']);
  assert.equal(f.calls.filter(x=>x.channel==='session:sendMessage').length,0);
  assert.equal((await f.bridge.inspect('original')).state,'busy');
});
test('modern native error envelopes propagate without dispatching via the legacy owner',async t=>{
  const f=fixture(t);f.source.failure='native read refused';
  await assert.rejects(f.bridge.inspect('original'),/native read refused/);
  await assert.rejects(f.bridge.send('original','wake-1','execute'),/native read refused/);
  assert.equal(f.calls.filter(x=>x.channel==='session:sendMessage').length,0);
});
test('modern session identity and workspace must agree with the legacy binding',async t=>{
  const f=fixture(t);f.source.info.id='other';await assert.rejects(f.bridge.inspect('original'),/identity/i);
  f.source.info.id='original';f.source.info.space.cwd='C:\\other';await assert.rejects(f.bridge.inspect('original'),/workspace/i);
});
test('modern unknown state and live background work never count as stopped',async t=>{
  const f=fixture(t);f.source.info.state='unfamiliar';assert.equal((await f.bridge.inspect('original')).state,'busy');
  f.source.info.state='idle';f.source.info.hasRunningBackgroundTasks=true;assert.equal((await f.bridge.inspect('original')).state,'busy');
  f.source.info.hasRunningBackgroundTasks=false;f.source.info.hasActiveChildAgents=true;assert.equal((await f.bridge.inspect('original')).state,'busy');
});
test('pending GUI state without a visible input remains occupied',async t=>{
  const f=fixture(t);f.source.info.state='pending';assert.equal((await f.bridge.inspect('original')).state,'busy');
});
test('native queued work blocks new dispatch and cannot be silently resumed or removed',async t=>{
  const f=fixture(t);f.source.queued=[{id:'user-queued-work',clientRequestId:'user-request'}];
  assert.equal((await f.bridge.inspect('original')).state,'busy');
  await assert.rejects(f.bridge.send('original','wake-1','[CODEX_QUEUE_WAKE wake-1]\nexecute'),/idle/i);
  assert.equal(f.modernCalls.some(x=>/sendPrompt|queueResume|queueDelete/.test(x.channel)),false);
});
test('cooperative cancellation reaches both native owners without answering a permission',async t=>{
  const f=fixture(t);f.source.info.state='working';await f.bridge.cancel('original');
  assert.equal(f.calls.filter(x=>x.channel==='session:cancel').length,1);
  assert.equal(f.modernCalls.filter(x=>x.channel==='wb:conversations:cancel').length,1);
  assert.equal(f.modernCalls.some(x=>/resolvePending|rejectPending|configSet/.test(x.channel)),false);
});
test('a fresh session is created by the GUI owner with the stable native id',async t=>{
  const f=fixture(t);assert.equal(await f.bridge.create('C:\\fixture','new-session'),'new-session');
  const creates=f.modernCalls.filter(x=>x.channel==='wb:conversations:create');assert.equal(creates.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(creates[0].args[0])),{cwd:'C:\\fixture',conversationId:'new-session',transport:'local',isPlayground:false});
  assert.equal(f.calls.some(x=>/workspace:initialize|session:create/.test(x.channel)),false);
});
test('a GUI session absent from the legacy manager is observable and cancellable',async t=>{
  const f=fixture(t);f.source.legacy=undefined;
  assert.equal((await f.bridge.inspect('original')).state,'idle');
  await f.bridge.cancel('original');assert.equal(f.calls.filter(x=>x.channel==='session:cancel').length,0);
  assert.equal(f.modernCalls.filter(x=>x.channel==='wb:conversations:cancel').length,1);
});
test('GUI creation errors never create a second legacy owner',async t=>{
  const f=fixture(t);f.source.failure='creation refused';await assert.rejects(f.bridge.create('C:\\fixture','new-session'),/creation refused/);
  assert.equal(f.calls.some(x=>/workspace:initialize|session:create/.test(x.channel)),false);
});

test('local project and assistant spaces retain their authorized workspace',async t=>{
  const f=fixture(t);
  for(const type of ['project','assistant']){
    f.source.info.space.type=type;
    assert.equal((await f.bridge.inspect('original')).state,'idle');
    assert.equal((await f.bridge.inspect('original')).workspace,'C:\\fixture');
  }
});

test('cloud transport cannot dispatch or cancel even with a matching local-looking workspace',async t=>{
  const f=fixture(t);f.source.info.transport='cloud';
  await assert.rejects(f.bridge.inspect('original'),/transport|local/i);
  await assert.rejects(f.bridge.send('original','wake-1','[CODEX_QUEUE_WAKE wake-1]\nexecute'),/transport|local/i);
  await assert.rejects(f.bridge.cancel('original'),/transport|local/i);
  assert.equal(f.calls.some(x=>x.channel==='session:cancel'),false);
  assert.equal(f.modernCalls.some(x=>/sendPrompt|:cancel$/.test(x.channel)),false);
});

test('GUI cancellation validates identity and workspace before either owner is stopped',async t=>{
  const f=fixture(t);await f.bridge.inspect('original');
  for(const [field,value] of [['id','other-session'],['cwd','C:\\other']]){
    if(field==='id')f.source.info.id=value;else f.source.info.space.cwd=value;
    await assert.rejects(f.bridge.cancel('original'),/identity|workspace/i);
    f.source.info.id='original';f.source.info.space.cwd='C:\\fixture';
  }
  assert.equal(f.calls.some(x=>x.channel==='session:cancel'),false);
  assert.equal(f.modernCalls.some(x=>x.channel==='wb:conversations:cancel'),false);
});

test('cancellation refuses mismatched or malformed legacy identity before native mutations',async t=>{
  const f=fixture(t);await f.bridge.inspect('original');
  for(const legacy of [{sessionId:'another',cwd:'C:\\fixture',status:'idle'},{sessionId:'original',cwd:'C:\\other',status:'idle'},{}]){
    f.source.legacy=legacy;
    await assert.rejects(f.bridge.cancel('original'),/identity|workspace|malformed/i);
  }
  assert.equal(f.calls.some(x=>x.channel==='session:cancel'),false);
  assert.equal(f.modernCalls.some(x=>x.channel==='wb:conversations:cancel'),false);
});

test('a lost legacy owner cannot replace the previously verified workspace binding',async t=>{
  const f=fixture(t);await f.bridge.inspect('original');f.source.legacy=null;f.source.info.space.cwd='C:\\other';
  await assert.rejects(f.bridge.inspect('original'),/workspace/i);
  await assert.rejects(f.bridge.cancel('original'),/workspace/i);
  assert.equal(f.modernCalls.some(x=>x.channel==='wb:conversations:cancel'),false);
});

test('legacy cancellation failure still reaches the matching GUI owner and remains a failure',async t=>{
  const f=fixture(t);f.source.info.state='working';f.source.legacyCancelFailure='legacy cancel rejected';
  await assert.rejects(f.bridge.cancel('original'),/legacy cancel rejected/);
  assert.equal(f.calls.filter(x=>x.channel==='session:cancel').length,1);
  assert.equal(f.modernCalls.filter(x=>x.channel==='wb:conversations:cancel').length,1);
  assert.equal(f.modernCalls.some(x=>/resolvePending|rejectPending|configSet/.test(x.channel)),false);
});

test('both cancellation failures are preserved without claiming native stop',async t=>{
  const f=fixture(t);f.source.legacyCancelFailure='legacy cancel rejected';f.source.modernCancelFailure='GUI cancel rejected';
  await assert.rejects(f.bridge.cancel('original'),error=>/legacy cancel rejected/.test(error.message)&&/GUI cancel rejected/.test(error.message));
  assert.equal(f.calls.filter(x=>x.channel==='session:cancel').length,1);
  assert.equal(f.modernCalls.filter(x=>x.channel==='wb:conversations:cancel').length,1);
});

test('GUI-only cancellation requires an established workspace binding',async t=>{
  const f=fixture(t);f.source.legacy=null;
  await assert.rejects(f.bridge.cancel('original'),/workspace.*unconfirmed|binding/i);
  assert.equal(f.modernCalls.some(x=>x.channel==='wb:conversations:cancel'),false);
  await f.bridge.inspect('original');
  await f.bridge.cancel('original');
  assert.equal(f.modernCalls.filter(x=>x.channel==='wb:conversations:cancel').length,1);
  assert.equal(f.calls.some(x=>x.channel==='session:cancel'),false);
});

test('legacy absence never turns malformed active-session observations into confirmed idle',async t=>{
  const f=fixture(t);f.source.legacy=null;
  for(const active of [undefined,null,{}, {sessions:'unconfirmed'}, {sessions:null}]){
    f.source.active=active;
    await assert.rejects(f.bridge.inspect('original'),/active.*malformed/i);
    await assert.rejects(f.bridge.send('original','wake-1','[CODEX_QUEUE_WAKE wake-1]\nexecute'),/active.*malformed/i);
  }
  assert.equal(f.modernCalls.some(x=>x.channel==='wb:conversations:sendPrompt'),false);
  f.source.active={sessions:[]};assert.equal((await f.bridge.inspect('original')).state,'idle');
});
