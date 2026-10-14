import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as actor from '../dist/infrastructure/workbuddy/actor.js';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'actor-runtime-boundary-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const config=path.join(root,'config'),versions=path.join(config,'binaries','node','versions');fs.mkdirSync(path.join(versions,'22.22.2-6'),{recursive:true});
 const gateway=path.join(root,'gateway-node.exe'),desktop=path.join(root,'WorkBuddy.exe'),managed=path.join(versions,'22.22.2-6','node.exe'),foreign=path.join(root,'project','node.exe');
 fs.mkdirSync(path.dirname(foreign));for(const f of [gateway,desktop,managed,foreign])fs.writeFileSync(f,'offline executable identity fixture');
 return {root,config,versions,gateway,desktop,managed,foreign,lineage:[{pid:100,exe:managed},{pid:200,exe:desktop}]};}
test('native managed Node is trusted independently of the gateway Node version',t=>{const f=fixture(t);
 assert.equal(actor.verifyWorkBuddyLineage(f.lineage,100,200,f.desktop,f.gateway,f.config),true);
 assert.equal(actor.verifyWorkBuddyLineage([{pid:100,exe:f.gateway},{pid:200,exe:f.desktop}],100,200,f.desktop,f.gateway,f.config),true);
});
test('arbitrary project Node, prefix collision and staging runtime paths are rejected',t=>{const f=fixture(t);
 const collision=path.join(f.config,'binaries','node','versions-other','22.22.2-6','node.exe');
 const staging=path.join(f.versions,'.installing.22.22.2-6','node.exe');
 for(const file of [collision,staging]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');}
 for(const exe of [f.foreign,collision,staging])assert.equal(actor.verifyWorkBuddyLineage([{pid:100,exe},{pid:200,exe:f.desktop}],100,200,f.desktop,f.gateway,f.config),false);
});
test('a version junction cannot move the trusted Node outside its configured root',t=>{const f=fixture(t);
 const external=path.dirname(f.foreign),link=path.join(f.versions,'24.1.0');fs.symlinkSync(external,link,'junction');
 const exe=path.join(link,'node.exe');assert.equal(actor.verifyWorkBuddyLineage([{pid:100,exe},{pid:200,exe:f.desktop}],100,200,f.desktop,f.gateway,f.config),false);
});
test('a configured root junction cannot become a newly trusted location',t=>{const f=fixture(t);
 const link=path.join(f.root,'linked-config');fs.symlinkSync(f.config,link,'junction');
 assert.equal(actor.verifyWorkBuddyLineage(f.lineage,100,200,f.desktop,f.gateway,link),false);
});
test('missing executable paths, wrong actor PID and foreign desktop ancestry fail closed',t=>{const f=fixture(t);
 assert.equal(actor.sameExecutable(path.join(f.root,'missing.exe'),path.join(f.root,'missing.exe')),false);
 for(const [lineage,pid,desktopPid] of [[f.lineage,101,200],[f.lineage,100,100],[[{pid:100,exe:f.managed},{pid:201,exe:f.desktop}],100,200],[[{pid:100,exe:f.managed},{pid:200,exe:f.foreign}],100,200]])
   assert.equal(actor.verifyWorkBuddyLineage(lineage,pid,desktopPid,f.desktop,f.gateway,f.config),false);
});
