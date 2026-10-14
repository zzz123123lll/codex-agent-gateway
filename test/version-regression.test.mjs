import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('relocated release metadata controls HTTP health and actual MCP handshake in a fresh process',t=>{
 const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),fixture=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-version-relocated-'));
 t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
 fs.cpSync(path.join(sourceRoot,'dist'),path.join(fixture,'dist'),{recursive:true});
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({type:'module',version:'9.9.9'}));
 fs.symlinkSync(path.join(sourceRoot,'node_modules'),path.join(fixture,'node_modules'),process.platform==='win32'?'junction':'dir');
 const program=String.raw`
 import {createHubServer} from './dist/transport/http.js';
 import {createMcpServer} from './dist/transport/mcp.js';
 import {Client} from '@modelcontextprotocol/sdk/client/index.js';
 import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
 const http=createHubServer({maxConcurrent:1},'offline-version-fixture');
 const mcp=createMcpServer({}),client=new Client({name:'isolated version check',version:'1.0.0'});
 try{
   await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
   const health=await fetch('http://127.0.0.1:'+http.address().port+'/v1/health',{headers:{authorization:'Bearer offline-version-fixture'}}).then(response=>response.json());
   const [a,b]=InMemoryTransport.createLinkedPair();await mcp.connect(a);await client.connect(b);
   console.log(JSON.stringify({http:health.version,mcp:client.getServerVersion().version}));
 }finally{await client.close();await mcp.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve))}
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',program],{cwd:fixture,encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(child.status,0,child.stderr||child.error?.message);assert.deepEqual(JSON.parse(child.stdout.trim()),{http:'9.9.9',mcp:'9.9.9'});
});
