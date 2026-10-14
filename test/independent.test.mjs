// Codex-owned independent behavioral checks; executor must not alter this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {HubStore} from '../dist/platform/store.js';
import {HubEngine,readResult} from '../dist/platform/engine.js';
import {HubError} from '../dist/platform/contracts.js';
import {AgentHubClient} from '../dist/platform/client.js';
import {createHubServer} from '../dist/platform/http.js';
import {dashboardHtml} from '../dist/platform/ui.js';

class DesktopFixture {
  id='trae'; label='test desktop'; capabilities={}; states=new Map(); sends=[]; corrections=[]; acknowledgments=[];
  async health(){return {state:'configured',usage:{credits:null,source:'unavailable'}}}
  async submit(run){this.sends.push(structuredClone(run));if(this.failure)throw this.failure;this.states.set(run.id,{status:'running',holdsCapacity:true,attemptId:'a'+run.round,sessionId:'native-session',events:[]})}
  async poll(run){return this.states.get(run.id)}
  async rework(run){this.corrections.push(structuredClone(run));await this.submit(run)}
  async cancel(){}
  async accept(run){this.acknowledgments.push(run.id)}
  async recover(run){this.states.set(run.id,{status:'failed',holdsCapacity:false,attemptId:run.attemptId,sessionId:run.sessionId,events:[]})}
  finish(run,body={text:'checked output',artifacts:[]},held=false){fs.writeFileSync(run.resultFile,JSON.stringify(body));this.states.set(run.id,{status:'completed',holdsCapacity:held,attemptId:'a'+run.round,sessionId:'native-session',accepted:true,events:[{key:'finish-'+run.round,type:'provider',text:'native stop'}]})}
}
function fixture(t,capacity=1){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-rewrite-'));
 const store=new HubStore(path.join(directory,'hub.sqlite')),provider=new DesktopFixture(),engine=new HubEngine(store,[provider],directory,capacity);
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})});
 return {directory,store,provider,engine};
}
async function listener(t,f){
 const token='e'.repeat(64),server=createHubServer(f.engine,token);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}));
 const url='http://127.0.0.1:'+server.address().port;
 return {server,token,url,client:new AgentHubClient(url,token),headers:{authorization:'Bearer '+token}};
}

test('请求默认值与真实目录规范化后幂等，变更拒绝且重启仍保留',async t=>{
 const f=fixture(t),work=path.join(f.directory,'project');fs.mkdirSync(work);
 const first=f.engine.submit({task:'  implement  ',workspace:work,idempotencyKey:'stable'});
 assert.equal(first.created,true);assert.equal(f.engine.submit({task:'implement',provider:'trae',workspace:work+path.sep,output:'text',constraints:[],timeoutSeconds:1800,idempotencyKey:'stable'}).created,false);
 assert.throws(()=>f.engine.submit({task:'changed',workspace:work,idempotencyKey:'stable'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
 const second=new HubStore(path.join(f.directory,'hub.sqlite'));try{assert.equal(second.get(first.run.id).input.task,'implement')}finally{second.close()}
});
test('跨执行端父子互斥，兄弟前缀目录可同时执行且并行tick不双发',async t=>{
 const f=fixture(t,2),other=new DesktopFixture();other.id='workbuddy';f.engine.providers.set(other.id,other);
 const parent=path.join(f.directory,'project'),child=path.join(parent,'nested'),sibling=path.join(f.directory,'project-other');
 fs.mkdirSync(child,{recursive:true});fs.mkdirSync(sibling);
 const a=f.engine.submit({task:'parent',workspace:parent}).run,b=f.engine.submit({task:'child',workspace:child,provider:'workbuddy'}).run,c=f.engine.submit({task:'sibling',workspace:sibling,provider:'workbuddy'}).run;
 await Promise.all([f.engine.tick(),f.engine.tick(),f.engine.tick()]);
 assert.equal(f.provider.sends.length,1);assert.deepEqual(other.sends.map(x=>x.id),[c.id]);assert.equal(f.engine.get(b.id).status,'queued');
 f.provider.finish(a);await f.engine.tick();assert.equal(other.sends.at(-1).id,b.id);
});
test('发送不确定及重启仅查询原尝试，保持占位，禁止自动重发',async t=>{
 const f=fixture(t);f.provider.failure=Error('lost dispatch receipt');
 const a=f.engine.submit({task:'uncertain'}).run,b=f.engine.submit({task:'next'}).run;
 await f.engine.tick();await new HubEngine(f.store,[f.provider],f.directory).tick();
 assert.equal(f.provider.sends.length,1);assert.equal(f.engine.get(a.id).holdsCapacity,true);assert.equal(f.engine.get(b.id).status,'queued');
 await assert.rejects(f.engine.rework(a.id,'retry uncertain'),e=>e.code==='RUN_ACTIVE');
});
test('已确认未发送允许显式返工，不能自动重试',async t=>{
 const f=fixture(t);f.provider.failure=new HubError('DISPATCH_NOT_SENT','native never received prompt');
 const a=f.engine.submit({task:'pre-send failure'}).run;await f.engine.tick();await f.engine.tick();
 assert.equal(f.provider.sends.length,1);assert.equal(f.engine.get(a.id).holdsCapacity,false);
 const next=await f.engine.rework(a.id,'retry after configuration repaired');assert.equal(next.round,2);assert.equal(next.review,'pending');
 f.provider.failure=undefined;await f.engine.tick();assert.equal(f.provider.sends.length,2);
});
test('原生结束与独立验收分离，验收后返工清旧成果但保留同会话审计',async t=>{
 const f=fixture(t),a=f.engine.submit({task:'quality'}).run;await f.engine.tick();f.provider.finish(a);await f.engine.tick();
 assert.equal(f.engine.get(a.id).review,'pending');
 await assert.rejects(f.engine.accept(a.id,{note:'self-described',evidence:[]}));
 await f.engine.accept(a.id,{note:'independently checked',evidence:['actual assertion passed']});
 const before=f.engine.get(a.id),next=await f.engine.rework(a.id,'BUG-001: expected value missing; fix and retest');
 assert.equal(next.id,a.id);assert.equal(next.sessionId,before.sessionId);assert.equal(next.review,'pending');assert.equal(next.result,undefined);assert.notEqual(next.resultFile,before.resultFile);
 await f.engine.tick();assert.equal(f.provider.corrections[0].sessionId,before.sessionId);
 const audit=f.store.events(a.id,0,100).find(e=>e.type==='rework');assert.equal(audit.data.previousResultDigest,before.result.digest);assert.match(audit.data.feedback,/BUG-001/);
});
test('旧attempt不能被新轮接受，cancel请求不等于停止，停止后同会话返工',async t=>{
 const f=fixture(t),a=f.engine.submit({task:'cancel'}).run;await f.engine.tick();
 assert.equal((await f.engine.cancel(a.id)).holdsCapacity,true);
 await assert.rejects(f.engine.rework(a.id,'still active'));
 f.provider.states.set(a.id,{status:'cancelled',holdsCapacity:false,attemptId:'a1',sessionId:'native-session',events:[]});await f.engine.tick();
 const next=await f.engine.rework(a.id,'resume stopped attempt');
 f.store.save({...next,status:'dispatching',holdsCapacity:true});f.provider.states.set(a.id,{status:'completed',holdsCapacity:false,attemptId:'a1',sessionId:'native-session',events:[]});
 await f.engine.tick();assert.equal(f.engine.get(a.id).holdsCapacity,true);assert.equal(f.engine.get(a.id).status,'uncertain');assert.equal(f.provider.corrections.length,0);
});
test('完成但占位不允许验收，检查恢复不派工不验收',async t=>{
 const f=fixture(t),a=f.engine.submit({task:'held complete'}).run;await f.engine.tick();f.provider.finish(a,undefined,true);await f.engine.tick();
 await assert.rejects(f.engine.accept(a.id,{note:'check',evidence:['check']}));
 f.store.save({...f.engine.get(a.id),status:'uncertain',holdsCapacity:true});
 const after=await f.engine.recover(a.id,'inspected original native session idle');
 assert.equal(after.holdsCapacity,false);assert.equal(after.review,'pending');assert.equal(f.provider.sends.length,1);
});
test('文件和结果被改写后拒绝验收，JSON null合法',async t=>{
 const f=fixture(t),a=f.engine.submit({task:'artifacts',output:'json'}).run;await f.engine.tick();
 const file=path.join(a.workspace,'delivered.txt');fs.writeFileSync(file,'revision one');
 f.provider.finish(a,{text:'null data',json:null,artifacts:[file]});await f.engine.tick();assert.equal(f.engine.get(a.id).result.json,null);
 fs.writeFileSync(file,'revision two');await assert.rejects(f.engine.accept(a.id,{note:'checked',evidence:['previous check']}),e=>e.code==='OUTPUT_CHANGED');
 fs.writeFileSync(a.resultFile,JSON.stringify({text:'replacement',json:null,artifacts:[]}));await assert.rejects(f.engine.accept(a.id,{note:'checked',evidence:['previous check']}));
});
test('输出目录/链接逃逸/超大文件被拒绝且不发布成果',async t=>{
 const f=fixture(t),a=f.engine.submit({task:'boundary',output:'artifacts'}).run,outside=path.join(f.directory,'outside.txt');fs.writeFileSync(outside,'private');
 const link=path.join(a.workspace,'escape');fs.symlinkSync(f.directory,link,process.platform==='win32'?'junction':'dir');
 for(const value of [outside,path.join(link,'outside.txt'),a.workspace]){
 fs.writeFileSync(a.resultFile,JSON.stringify({text:'invalid',artifacts:[value]}));assert.throws(()=>readResult(a))}
 fs.writeFileSync(a.resultFile,'x'.repeat(1048577));assert.throws(()=>readResult(a));
});
test('旧SQLite兼容读取、同事件键去重与游标持久性',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-agent-')),file=path.join(dir,'hub.sqlite'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE hub_runs(id TEXT PRIMARY KEY,request_key TEXT UNIQUE,fingerprint TEXT NOT NULL,body TEXT NOT NULL);CREATE TABLE hub_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,event_key TEXT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,event_key));');
 const legacy={id:'legacy',status:'completed',review:'accepted',round:3,input:{provider:'workbuddy'},sessionId:'original',holdsCapacity:false,updatedAt:'2026-10-11T00:00:00Z'};
 db.prepare('INSERT INTO hub_runs VALUES(?,?,?,?)').run('legacy','old-key','old-hash',JSON.stringify(legacy));db.close();
 const store=new HubStore(file);t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});
 assert.deepEqual(store.get('legacy'),legacy);store.event('legacy','provider',{text:'event'},'receipt');store.event('legacy','provider',{text:'event'},'receipt');
 assert.equal(store.events('legacy').length,1);assert.equal(store.events('legacy',store.events('legacy')[0].id).length,0);assert.equal(store.byKey('old-key','old-hash').sessionId,'original');
});
test('HTTP身份/来源/严格输入/错误处理、SDK等待不取消与结果下载',async t=>{
 const f=fixture(t),net=await listener(t,f);
 assert.equal((await fetch(net.url+'/v1/runs')).status,401);
 assert.equal((await fetch(net.url+'/v1/runs',{headers:{...net.headers,origin:'https://foreign.invalid'}})).status,403);
 const wrong=await new Promise((resolve,reject)=>http.get(net.url+'/v1/health',{headers:{...net.headers,host:'foreign.invalid'}},r=>{r.resume();resolve(r.statusCode)}).on('error',reject));assert.equal(wrong,403);
 const anonymous=await fetch(net.url);assert.equal(anonymous.headers.get('set-cookie'),null);assert.ok(!(await anonymous.text()).includes(net.token));
 const auth=await fetch(net.url,{headers:net.headers});assert.match(auth.headers.get('set-cookie'),/HttpOnly/);
 await assert.rejects(net.client.submit({task:'unknown field',other:true}));
 const {run}=await net.client.submit({task:'download',output:'artifacts'});
 await assert.rejects(net.client.wait(run.id,{timeoutMs:20}));assert.equal(f.engine.get(run.id).status,'queued');
 await f.engine.tick();const file=path.join(run.workspace,'output.txt');fs.writeFileSync(file,'verified bytes');f.provider.finish(run,{text:'delivered',artifacts:[file]});await f.engine.tick();
 assert.equal((await net.client.wait(run.id,{timeoutMs:1000})).status,'completed');
 assert.equal(await (await fetch(net.url+'/v1/runs/'+run.id+'/artifacts/0',{headers:net.headers})).text(),'verified bytes');
 fs.writeFileSync(file,'tampered');assert.equal((await fetch(net.url+'/v1/runs/'+run.id+'/artifacts/0',{headers:net.headers})).status,409);
 assert.throws(()=>new AgentHubClient('https://remote.invalid',net.token));
});
test('SSE恢复游标、非法游标与工作台脚本安全语法',async t=>{
 const f=fixture(t),net=await listener(t,f),{run}=await net.client.submit({task:'stream'});
 const controller=new AbortController(),response=await fetch(net.url+'/v1/runs/'+run.id+'/stream',{headers:net.headers,signal:controller.signal}),reader=response.body.getReader();
 const chunk=await reader.read();assert.match(new TextDecoder().decode(chunk.value),/event: state/);controller.abort();await reader.cancel().catch(()=>{});
 assert.equal((await fetch(net.url+'/v1/runs/'+run.id+'/events?after=NaN',{headers:net.headers})).status,400);
 const html=dashboardHtml(),scripts=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
 assert.ok(scripts.length);for(const script of scripts){assert.doesNotThrow(()=>new vm.Script(script[1]));assert.ok(!script[1].includes('innerHTML'))}
});
