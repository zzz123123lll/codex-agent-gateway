import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

async function runFixture(t,mode){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'worker-native-shim-'));
  const reports=[];const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;reports.push(JSON.parse(text));res.setHeader('content-type','application/json');res.end('{"ok":true}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  const grant={id:'offline-fixture',url:'http://127.0.0.1:'+server.address().port,lease:'a'.repeat(64),desktopPid:54321,executable:'C:\\fixture\\WorkBuddy.exe'};
  const grantFile=path.join(directory,'grant.json'),resultFile=path.join(directory,'output.json'),preload=path.join(directory,'native-host-fixture.mjs');
  fs.writeFileSync(grantFile,JSON.stringify(grant));fs.writeFileSync(resultFile,'{"text":"offline fixture report"}');
  // Simulate the observed host constraint. Never call the real gateway or impersonate a native model.
  fs.writeFileSync(preload,`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
    cp.execFileSync=()=>{throw Object.assign(Error('host rejects synchronous spawn'),{code:'EBUSY'})};
    cp.execFile=(file,args,options,callback)=>{
      if(file!=='powershell.exe'||options.windowsHide!==true||options.timeout!==15000)throw Error('unexpected query');
      queueMicrotask(()=>${mode==='query-error'?'callback(Error("native query unavailable"))':`callback(null,JSON.stringify([{pid:${mode==='foreign'?54322:54321},exe:'C:\\\\fixture\\\\WorkBuddy.exe'}]),'')`});
      return {kill(){}};
    };syncBuiltinESMExports();`);
  const worker=spawn(process.execPath,[path.resolve('scripts/worker.mjs'),'report',grantFile,'completed',resultFile],{
    windowsHide:true,env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--import='+pathToFileURL(preload).href].filter(Boolean).join(' ')},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';worker.stdout.on('data',x=>stdout+=x);worker.stderr.on('data',x=>stderr+=x);
  const code=await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('close',resolve)});
  return {code,stdout,stderr,reports};
}
test('report helper works when the native host rejects synchronous spawning',async t=>{
  const r=await runFixture(t,'native');assert.equal(r.code,0,r.stderr);assert.equal(r.reports.length,1);
  assert.equal(r.reports[0].status,'completed');assert.equal(r.reports[0].text,'offline fixture report');assert.ok(r.reports[0].actorPid>0);
});
test('asynchronous ancestry still rejects a foreign desktop before any report',async t=>{
  const r=await runFixture(t,'foreign');assert.notEqual(r.code,0);assert.match(r.stderr,/registered execution desktop/);assert.equal(r.reports.length,0);
});
test('failed native ancestry query never sends a report',async t=>{
  const r=await runFixture(t,'query-error');assert.notEqual(r.code,0);assert.match(r.stderr,/native query unavailable/);assert.equal(r.reports.length,0);
});
