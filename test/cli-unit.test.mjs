import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {readConfiguration, atomicJson, acquireServiceLock} from '../dist/runtime/settings.js';

function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-cli-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return directory;}
test('legacy concurrency environment override wins without changing persisted settings',t=>{
 const directory=fixture(t),file=path.join(directory,'settings.json'),raw=JSON.stringify({maxConcurrent:3});fs.writeFileSync(file,raw);
 assert.equal(readConfiguration(directory,{AGENT_HUB_MAX_CONCURRENT:'7'}).maxConcurrent,7);
 for(const value of ['0','17','1.2','NaN','-1'])assert.throws(()=>readConfiguration(directory,{AGENT_HUB_MAX_CONCURRENT:value}));
 assert.equal(readConfiguration(directory,{AGENT_HUB_MAX_CONCURRENT:''}).maxConcurrent,3);assert.equal(fs.readFileSync(file,'utf8'),raw);
});
test('ready connection preserves legacy startedAt and orderly close withdraws connection and lock',async t=>{
 const directory=fixture(t),server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const module=new URL('../dist/runtime/lifecycle.js',import.meta.url).href;
 const script=`import fs from 'node:fs';import assert from 'node:assert/strict';import {startRuntime} from ${JSON.stringify(module)};const directory=${JSON.stringify(directory)};const runtime=await startRuntime(directory);try{const c=JSON.parse(fs.readFileSync(directory+'/connection.json'));assert.equal(typeof c.startedAt,'string');assert.ok(Number.isFinite(Date.parse(c.startedAt)));assert.equal(c.updatedAt,c.startedAt);assert.equal(c.pid,process.pid);}finally{await runtime.close();}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,AGENT_HUB_PORT:String(port),AGENT_HUB_MAX_CONCURRENT:'1',TRAE_EXECUTABLE:'',WORKBUDDY_EXECUTABLE:''},encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(directory,'connection.json')),false);assert.equal(fs.existsSync(path.join(directory,'service.lock')),false);
});
test('configuration preserves zero-provider serving, validates persisted values and env overrides',t=>{
 const directory=fixture(t);fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({port:29555,maxConcurrent:4}));
 const c=readConfiguration(directory,{AGENT_HUB_PORT:'29556',TRAE_EXECUTABLE:'',WORKBUDDY_EXECUTABLE:''});assert.equal(c.port,29556);assert.equal(c.maxConcurrent,4);
 for(const raw of [{port:0},{maxConcurrent:17},{workbuddy:{cdpPort:18493}},{workbuddy:{reportPort:18493}}]){fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify(raw));assert.throws(()=>readConfiguration(directory,{}));}
});
test('service lock rejects live owner and does not erase replaced ownership',t=>{
 const directory=fixture(t),lease=acquireServiceLock(directory);assert.throws(()=>acquireServiceLock(directory),/already running/i);
 const file=path.join(directory,'service.lock');fs.writeFileSync(file,JSON.stringify({pid:process.pid,owner:'other'}));lease.release();assert.equal(JSON.parse(fs.readFileSync(file)).owner,'other');
});
test('atomic JSON publishes complete value and stale stopped lock is reclaimable',t=>{
 const directory=fixture(t),file=path.join(directory,'connection.json');atomicJson(file,{url:'http://127.0.0.1:12345'});assert.equal(JSON.parse(fs.readFileSync(file)).url,'http://127.0.0.1:12345');
 fs.writeFileSync(path.join(directory,'service.lock'),JSON.stringify({pid:2147483647,owner:'dead'}));const lease=acquireServiceLock(directory);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'service.lock'))).pid,process.pid);lease.release();assert.equal(fs.existsSync(path.join(directory,'service.lock')),false);
 assert.equal(fs.readdirSync(directory).some(f=>f.endsWith('.tmp')),false);
});
