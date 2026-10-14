import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {HubStore} from '../dist/platform/store.js';
import {HubEngine} from '../dist/platform/engine.js';
import {requestSchema} from '../dist/platform/contracts.js';
import {createHubServer} from '../dist/platform/http.js';

function build(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-boundary-')),store=new HubStore(path.join(directory,'hub.sqlite'));
 let dispatched=0;
 const provider={id:'trae',label:'fixture',capabilities:{},async health(){return {state:'configured',usage:{credits:null,source:'unavailable'}}},async submit(){dispatched++},async poll(){return undefined},async cancel(){},async rework(){},async accept(){}};
 const engine=new HubEngine(store,[provider],directory);
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})});return {directory,store,engine,count:()=>dispatched};
}
test('限制100个未派发任务，幂等重复在满队列仍返回原记录',t=>{
 const f=build(t),first=f.engine.submit({task:'first',idempotencyKey:'first'});
 for(let i=1;i<100;i++)f.engine.submit({task:'queued '+i});
 assert.equal(f.engine.submit({task:'first',idempotencyKey:'first'}).run.id,first.run.id);
 assert.throws(()=>f.engine.submit({task:'overflow'}),e=>e.code==='QUEUE_FULL');
 assert.equal(f.store.all().length,100);assert.equal(f.count(),0);
});
test('队列超时不发任务，取消未派发任务无原生调用',async t=>{
 const f=build(t),a=f.engine.submit({task:'expired'}).run,b=f.engine.submit({task:'cancel queued'}).run;
 f.store.save({...a,deadline:new Date(0).toISOString()});await f.engine.cancel(b.id);await f.engine.tick();
 assert.equal(f.engine.get(a.id).error.code,'QUEUE_TIMEOUT');assert.equal(f.engine.get(b.id).status,'cancelled');assert.equal(f.count(),0);
});
test('满队列拒绝返工且保留历史轮次与结果路径',async t=>{
 const f=build(t),finished=f.engine.submit({task:'previous attempt'}).run;
 f.store.save({...finished,status:'completed',sessionId:'session',attemptId:'attempt',holdsCapacity:false});
 for(let i=0;i<100;i++)f.engine.submit({task:'pending '+i});
 const before=f.engine.get(finished.id),events=f.store.events(finished.id);
 await assert.rejects(f.engine.rework(finished.id,'Correct the output'),e=>e.code==='QUEUE_FULL');
 assert.deepEqual(f.engine.get(finished.id),before);assert.deepEqual(f.store.events(finished.id),events);
 assert.equal(f.store.all().filter(r=>r.status==='queued').length,100);
});
test('输入严格限制并发/超时/约束/字段，不能部分成功',t=>{
 const f=build(t);
 for(const input of [{task:''},{task:' '},{task:'x',timeoutSeconds:9},{task:'x',timeoutSeconds:86401},{task:'x',timeoutSeconds:10.1},{task:'x',constraints:Array(101).fill('a')},{task:'x',constraints:['']},{task:'x',provider:'missing'},{task:'x',output:'unsupported'},{task:'x',unexpected:true}])assert.throws(()=>f.engine.submit(input));
 assert.equal(f.store.all().length,0);
 for(const concurrency of [0,17,1.1])assert.throws(()=>new HubEngine(f.store,[],f.directory,concurrency));
 assert.equal(requestSchema.parse({task:' x ',output:'json'}).task,'x');
});
test('HTTP拒绝非法JSON/类型/越界游标/超大报文且不泄露内部文件位置',async t=>{
 const f=build(t),token='f'.repeat(64),server=createHubServer(f.engine,token);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
 const url='http://127.0.0.1:'+server.address().port,auth={authorization:'Bearer '+token};
 for(const route of ['/v1/runs?offset=-1','/v1/runs?limit=1.2','/v1/runs?offset=9007199254740992']){
   assert.equal((await fetch(url+route,{headers:auth})).status,400);
 }
 assert.equal((await fetch(url+'/v1/runs',{method:'POST',headers:auth,body:'plain'})).status,415);
 assert.equal((await fetch(url+'/v1/runs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:'{'})).status,400);
 assert.equal((await fetch(url+'/v1/runs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:' '.repeat(1048577)})).status,413);
 const unexpected=await fetch(url+'/v1/runs',{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({task:'wrong directory',workspace:path.join(f.directory,'absent')})});
 assert.equal(unexpected.status,400);assert.ok(!(await unexpected.text()).includes(f.directory));
 assert.equal(f.store.all().length,0);
});
