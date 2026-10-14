import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AgentHubClient} from '../dist/transport/client.js';
import {createHubServer} from '../dist/transport/http.js';
import {dashboardHtml} from '../dist/transport/ui.js';
import {createMcpServer} from '../dist/transport/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

test('SDK only accepts canonical loopback origins, no redirects', async t => {
  for (const url of ['http://localhost:80','http://127.0.0.1:80/path','http://u:p@127.0.0.1:80','http://127.0.0.1:80?x','https://127.0.0.1']) assert.throws(()=>new AgentHubClient(url,'x'));
  const server=http.createServer((req,res)=>{res.writeHead(302,{location:'/secret'});res.end()});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const sdk=new AgentHubClient('http://127.0.0.1:'+server.address().port,'x');await assert.rejects(sdk.request('/v1/health'));
});
test('dashboard is syntactically valid and uses safe text rendering',()=>{
  const html=dashboardHtml();assert.ok(html.includes('验收'));assert.ok(!html.includes('innerHTML'));
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new vm.Script(script));
});
test('HTTP hides unexpected errors, strict body and disconnectable stream',async t=>{
  const engine={directory:'private/path',maxConcurrent:1,store:{list(){throw Error('secret token path')},events(){return []}},get(){return {id:'hub-test',status:'running',round:1,review:'pending'}},async describeProviders(){return []}};
  const server=createHubServer(engine,'secret');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const url='http://127.0.0.1:'+server.address().port,headers={authorization:'Bearer secret'};
  const reply=await fetch(url+'/v1/runs',{headers});assert.equal(reply.status,500);assert.ok(!(await reply.text()).includes('secret'));
  assert.equal((await fetch(url+'/v1/runs',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'[]'})).status,400);
  const abort=new AbortController();const sse=await fetch(url+'/v1/runs/hub-test/stream',{headers,signal:abort.signal});assert.equal(sse.status,200);const reader=sse.body.getReader();const data=await reader.read();assert.match(new TextDecoder().decode(data.value),/event: state/);abort.abort();await reader.cancel().catch(()=>{});
});
test('MCP exposes all ten tools and refuses invalid or unknown arguments before dispatch',async t=>{
  const dispatched=[];
  const server=createMcpServer({async request(route){dispatched.push(route);return {providers:[]}}});
  const client=new Client({name:'independent transport check',version:'1.0.0'}),[a,b]=InMemoryTransport.createLinkedPair();
  t.after(async()=>{await client.close();await server.close()});await server.connect(a);await client.connect(b);
  const list=await client.listTools();assert.equal(list.tools.length,10);assert.equal(new Set(list.tools.map(t=>t.name)).size,10);
  const invalid=await client.callTool({name:'agent_hub_wait',arguments:{id:'a',timeoutSeconds:51}});assert.equal(invalid.isError,true);assert.equal(dispatched.length,0);
  const unknown=await client.callTool({name:'agent_hub_none',arguments:{}});assert.equal(unknown.isError,true);assert.equal(dispatched.length,0);
  for(const name of ['constructor','toString']){const result=await client.callTool({name,arguments:{}});assert.equal(JSON.parse(result.content[0].text).error.code,'UNKNOWN_TOOL');assert.equal(dispatched.length,0)}
  const valid=await client.callTool({name:'agent_hub_providers',arguments:{}});assert.deepEqual(JSON.parse(valid.content[0].text),{providers:[]});assert.deepEqual(dispatched,['/v1/providers']);
});
test('HTTP inherited names are unknown routes rather than executable handlers',async t=>{
  const server=createHubServer({get(){return {id:'hub-known'}}},'token');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  for(const action of ['constructor','toString']){const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/runs/hub-known/'+action,{method:'POST',headers:{authorization:'Bearer token','content-type':'application/json'},body:'{}'});assert.equal(response.status,404)}
});
test('SDK bounds stalled response headers and body and preserves explicit caller abort',async t=>{
  const server=http.createServer((req,res)=>{if(req.url==='/body'){res.writeHead(200,{'content-type':'application/json'});res.write('{')}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const sdk=new AgentHubClient('http://127.0.0.1:'+server.address().port,'token',{requestTimeoutMs:35});
  for(const route of ['/headers','/body']){const backup=new AbortController(),timer=setTimeout(()=>backup.abort(Error('backup timeout')),200);try{await assert.rejects(sdk.request(route,'GET',undefined,backup.signal),e=>e.code==='REQUEST_TIMEOUT')}finally{clearTimeout(timer)}}
  const abort=new AbortController(),reason=Error('explicit caller stop');setTimeout(()=>abort.abort(reason),5);await assert.rejects(sdk.request('/headers','GET',undefined,abort.signal),e=>e===reason);
});
test('SDK wait sends legacy-compatible integer seconds while exact client deadline never cancels task',async t=>{
  const calls=[];const server=http.createServer((req,res)=>{calls.push(req.url);if(req.url.includes('hub-hanging'))return;const seconds=new URL(req.url,'http://127.0.0.1').searchParams.get('timeoutSeconds');res.writeHead(/^\d+$/.test(seconds)&&Number(seconds)>=1&&Number(seconds)<=50?200:400,{'content-type':'application/json'});res.end(JSON.stringify({id:'hub-integer',status:'completed'}))});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const sdk=new AgentHubClient('http://127.0.0.1:'+server.address().port,'token');assert.equal((await sdk.wait('hub-integer',{timeoutMs:1550})).status,'completed');assert.equal(calls.length,1);
  const started=Date.now();await assert.rejects(sdk.wait('hub-hanging',{timeoutMs:25}),error=>error.code==='WAIT_TIMEOUT');assert.ok(Date.now()-started<500);assert.ok(calls.every(route=>/^\d+$/.test(new URL(route,'http://127.0.0.1').searchParams.get('timeoutSeconds'))));assert.ok(!calls.some(route=>route.includes('/cancel')));
});
test('same descriptor download survives pathname substitution after hashing, cookie respects origin',async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'transport-descriptor-'))),file=path.join(root,'output.txt');fs.writeFileSync(file,'verified original');
  const run={id:'hub-artifact',workspace:root,resultFile:path.join(root,'result.json'),result:{artifacts:[{path:file,name:'output.txt',bytes:17,sha256:createHash('sha256').update('verified original').digest('hex')}]}};
  const engine={get(){return run}},server=createHubServer(engine,'safe-token');await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})});
  const url='http://127.0.0.1:'+server.address().port,auth={authorization:'Bearer safe-token'};
  const home=await fetch(url,{headers:auth}),cookie=home.headers.get('set-cookie').split(';')[0];await home.text();
  assert.equal((await fetch(url+'/v1/runs/hub-artifact',{headers:{cookie}})).status,200);
  assert.equal((await fetch(url+'/v1/runs/hub-artifact',{headers:{cookie,origin:'null'}})).status,403);
  const original=fs.createReadStream;
  fs.createReadStream=function(target,options){fs.renameSync(file,file+'.old');fs.writeFileSync(file,'substitute bytes!');return original.call(fs,target,options)};
  try{const download=await fetch(url+'/v1/runs/hub-artifact/artifacts/0',{headers:auth});assert.equal(download.status,200);assert.equal(await download.text(),'verified original')}finally{fs.createReadStream=original}
  assert.equal((await fetch(url+'/v1/runs/hub-artifact/artifacts/0',{headers:auth})).status,409);
});
test('chunked oversized requests return 413 without creating tasks',async t=>{
  let dispatched=false;const server=createHubServer({submit(){dispatched=true}},'token');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));
  const status=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/v1/runs',method:'POST',headers:{authorization:'Bearer token','content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.write(' '.repeat(1048577));req.end()});
  assert.equal(status,413);assert.equal(dispatched,false);
});
