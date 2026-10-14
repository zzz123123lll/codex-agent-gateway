import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {HubStore} from '../dist/platform/store.js';
import {HubEngine,readResult} from '../dist/platform/engine.js';

test('历史结果字段顺序不影响相同文件的正式验收',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-review-')),store=new HubStore(path.join(directory,'hub.sqlite'));
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true})});
 const provider={id:'trae',label:'fixture',capabilities:{},async health(){return {state:'configured',usage:{credits:null,source:'unavailable'}}},async submit(){},async poll(){},async cancel(){},async rework(){},async accept(){}};
 const engine=new HubEngine(store,[provider],directory),run=engine.submit({task:'legacy-result',output:'json'}).run,file=path.join(run.workspace,'output.txt');
 fs.writeFileSync(file,'unchanged legacy artifact');
 fs.writeFileSync(run.resultFile,JSON.stringify({text:'legacy output',json:{a:1,b:2},artifacts:[file]}));
 const current=readResult(run),a=current.artifacts[0];
 const legacy={text:current.text,json:{b:2,a:1},artifacts:[{path:a.path,name:a.name,bytes:a.bytes,sha256:a.sha256}],digest:current.digest};
 store.save({...run,status:'completed',result:legacy,attemptId:'original',sessionId:'session'});
 const accepted=await engine.accept(run.id,{note:'actual unchanged bytes checked',evidence:['completion and artifact SHA256 match']});
 assert.equal(accepted.review,'accepted');
});
