// Codex-owned acceptance: verifies isolated child service resources, never invokes desktop models.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
test('双执行端服务启动失败释放报告端口与锁，避免半启动',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-lifecycle-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const occupied=http.createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>occupied.close(r)));
 const port=occupied.address().port,reportPort=await freePort(),executable=path.join(directory,'WorkBuddy.exe');fs.writeFileSync(executable,'test fixture not executable');
 fs.writeFileSync(path.join(directory,'settings.json'),JSON.stringify({port,workbuddy:{executable,reportPort}}));
 const child=spawn(process.execPath,['dist/cli.js','serve'],{cwd:root,env:{...process.env,AGENT_HUB_STATE_DIR:directory,AGENT_HUB_PORT:String(port),TRAE_EXECUTABLE:'',WORKBUDDY_EXECUTABLE:executable},windowsHide:true,stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',b=>errors+=b);t.after(()=>{if(child.exitCode===null)child.kill()});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('startup did not terminate')),10000);child.once('exit',code=>{clearTimeout(timer);resolve(code)});child.once('error',error=>{clearTimeout(timer);reject(error)})});
 assert.equal(code,1,errors);assert.equal(fs.existsSync(path.join(directory,'service.lock')),false);
 const reopened=http.createServer();await new Promise((resolve,reject)=>{reopened.once('error',reject);reopened.listen(reportPort,'127.0.0.1',resolve)});await new Promise(r=>reopened.close(r));
});
