import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createInstallPlan}=require('../scripts/install-plan.mjs');

function fixture(t:{after:(fn:()=>void)=>void}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trae-install-'));
 const root=path.join(dir,"中文 项目 O'Brien"),appdata=path.join(dir,'appdata'),exe=path.join(dir,'独立 TRAE 安装','Trae CN.exe');
 fs.mkdirSync(path.dirname(exe),{recursive:true});fs.writeFileSync(exe,'test fixture, not an executable');
 fs.mkdirSync(path.join(path.dirname(exe),'bin'));fs.writeFileSync(path.join(path.dirname(exe),'bin/trae-cn.cmd'),'fixture only');
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'codex-trae-bridge.vsix'),'fixture only');
 const state=path.join(root,'data/platform'),config=path.join(appdata,'Trae CN/User/globalStorage/local-codex.codex-trae-bridge/gateway.json');
 t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,root,exe,state,config,appdata,env:{...process.env,APPDATA:appdata}};
}

test('installer derives paths from a relocated package with unicode, spaces and apostrophes',t=>{
 const f=fixture(t),plan=createInstallPlan(f.root,f.exe,f.env);
 assert.equal(plan.config.stateDirectory,f.state);assert.equal(plan.config.workerPath,path.join(f.root,'scripts/worker.mjs'));
 assert.equal(plan.config.executable,f.exe);assert.equal(plan.settings.port,18493);assert.equal(plan.settings.maxConcurrent,1);
 assert.equal(fs.existsSync(f.state),false);assert.equal(fs.existsSync(f.config),false);
});

test('reinstallation preserves existing service settings without writing during planning',t=>{
 const f=fixture(t);fs.mkdirSync(f.state,{recursive:true});const file=path.join(f.state,'settings.json');
 const raw=JSON.stringify({executable:'old',port:29495,maxConcurrent:4,custom:'preserved'});fs.writeFileSync(file,raw);
 const plan=createInstallPlan(f.root,f.exe,f.env);assert.equal(plan.settings.port,29495);assert.equal(plan.settings.maxConcurrent,4);assert.equal(plan.settings.custom,'preserved');assert.equal(plan.settings.executable,f.exe);assert.equal(fs.readFileSync(file,'utf8'),raw);
});

test('incomplete extension package fails before creating or changing installation settings',t=>{
 const f=fixture(t);fs.unlinkSync(path.join(f.root,'codex-trae-bridge.vsix'));
 assert.throws(()=>createInstallPlan(f.root,f.exe,f.env),/package first/);assert.equal(fs.existsSync(f.state),false);assert.equal(fs.existsSync(f.config),false);
});

test('installer rejects invalid persisted service settings instead of silently replacing them',t=>{
 const f=fixture(t);fs.mkdirSync(f.state,{recursive:true});const file=path.join(f.state,'settings.json');
 for(const value of [{port:0},{port:65536},{port:'18493'},{maxConcurrent:0},{maxConcurrent:17}]){
  const raw=JSON.stringify(value);fs.writeFileSync(file,raw);assert.throws(()=>createInstallPlan(f.root,f.exe,f.env),/invalid/i);assert.equal(fs.readFileSync(file,'utf8'),raw);
 }
});

test('another desktop gateway owner is preserved instead of being overwritten',t=>{
 const f=fixture(t);fs.mkdirSync(path.dirname(f.config),{recursive:true});const raw=JSON.stringify({stateDirectory:path.join(f.dir,'other/data/platform')});fs.writeFileSync(f.config,raw);
 assert.throws(()=>createInstallPlan(f.root,f.exe,f.env),/another gateway/);assert.equal(fs.readFileSync(f.config,'utf8'),raw);assert.equal(fs.existsSync(f.state),false);
});

test('uninstall from an unrelated package refuses before changing the live desktop owner',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'scripts'));for(const name of ['uninstall.ps1','environment.ps1'])fs.copyFileSync(path.resolve('scripts',name),path.join(f.root,'scripts',name));
 fs.mkdirSync(path.dirname(f.config),{recursive:true});const raw=JSON.stringify({stateDirectory:path.join(f.dir,'other/data/platform')});fs.writeFileSync(f.config,raw);
 const result=spawnSync('pwsh.exe',['-NoProfile','-File',path.join(f.root,'scripts/uninstall.ps1')],{env:f.env,encoding:'utf8',windowsHide:true,timeout:15000});
 assert.notEqual(result.status,0);assert.match(result.stderr,/another gateway directory/);assert.equal(fs.readFileSync(f.config,'utf8'),raw);assert.equal(fs.existsSync(f.state),false);
});

test('real Windows setup preflight honors isolated CODEX_HOME and performs no installation',t=>{
 const f=fixture(t),source=path.resolve('scripts');fs.mkdirSync(path.join(f.root,'scripts'));
 for(const name of ['setup.ps1','environment.ps1'])fs.copyFileSync(path.join(source,name),path.join(f.root,'scripts',name));
 for(const name of ['package.json','package-lock.json','skills/trae-executor/SKILL.md','skills/agent-executor/SKILL.md','extension/bridge.cjs']){const file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.resolve(name),file);}
 const codexState=path.join(f.dir,'Codex 独立配置');fs.mkdirSync(codexState);
 const env={...f.env,CODEX_HOME:codexState};
 const run=()=>spawnSync('pwsh.exe',['-NoProfile','-File',path.join(f.root,'scripts/setup.ps1'),'-CheckOnly','-TraeExecutable',f.exe],{env,encoding:'utf8',windowsHide:true,timeout:20000});
 const fresh=run();assert.equal(fresh.status,0,fresh.stderr);const plan=JSON.parse(fresh.stdout);
 assert.equal(plan.codexRoot,codexState);assert.equal(plan.skillDirectory,path.join(codexState,'skills/trae-executor'));assert.equal(plan.mcpExists,false);assert.equal(plan.mutationsPerformed,false);assert.equal(fs.existsSync(f.state),false);assert.equal(fs.existsSync(f.config),false);
 const raw='[mcp_servers.trae-gateway]\ncommand="node"\nargs=["C:/another-gateway/dist/platform/mcp.js"]\n';fs.writeFileSync(path.join(codexState,'config.toml'),raw);
 const conflict=run();assert.notEqual(conflict.status,0);assert.match(conflict.stderr,/Another trae-gateway/);assert.equal(fs.readFileSync(path.join(codexState,'config.toml'),'utf8'),raw);assert.equal(fs.existsSync(f.state),false);assert.equal(fs.existsSync(f.config),false);
});

test('real Windows WorkBuddy-only preflight needs no TRAE launcher and rejects invalid ports before changes',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'scripts'));for(const name of ['setup.ps1','environment.ps1','workbuddy-install-plan.mjs'])fs.copyFileSync(path.resolve('scripts',name),path.join(f.root,'scripts',name));
 for(const name of ['package.json','package-lock.json','skills/trae-executor/SKILL.md','skills/agent-executor/SKILL.md','extension/bridge.cjs']){const file=path.join(f.root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.copyFileSync(path.resolve(name),file);}
 const wbExe=path.join(f.dir,"WorkBuddy 中文 O'Brien",'WorkBuddy.exe');fs.mkdirSync(path.join(path.dirname(wbExe),'resources'),{recursive:true});fs.writeFileSync(wbExe,'fixture only');fs.writeFileSync(path.join(path.dirname(wbExe),'resources/app.asar'),'fixture only');
 const codexState=path.join(f.dir,'independent Codex');fs.mkdirSync(codexState);const env={...f.env,CODEX_HOME:codexState,TRAE_EXECUTABLE:'',WORKBUDDY_EXECUTABLE:''};
 const run=()=>spawnSync('pwsh.exe',['-NoProfile','-File',path.join(f.root,'scripts/setup.ps1'),'-CheckOnly','-WorkBuddyExecutable',wbExe],{env,encoding:'utf8',windowsHide:true,timeout:20000});
 const fresh=run();assert.equal(fresh.status,0,fresh.stderr);const plan=JSON.parse(fresh.stdout);assert.equal(plan.workbuddyExecutable,wbExe);assert.ok(!plan.executable);assert.equal(plan.mutationsPerformed,false);assert.equal(fs.existsSync(f.state),false);assert.equal(fs.existsSync(f.config),false);
 fs.mkdirSync(f.state,{recursive:true});const file=path.join(f.state,'settings.json'),raw=JSON.stringify({workbuddy:{reportPort:18493}});fs.writeFileSync(file,raw);const invalid=run();assert.notEqual(invalid.status,0);assert.match(invalid.stderr,/validation failed before installation/);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.equal(fs.existsSync(f.config),false);
});
