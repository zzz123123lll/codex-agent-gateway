import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {AgentHubClient} from '../dist/platform/client.js';
async function main(){
const root=fileURLToPath(new URL('../',import.meta.url)),workspace=path.join(root,'data','verification',process.argv[2]??'project-a');fs.mkdirSync(workspace,{recursive:true});
const client=AgentHubClient.local(path.join(root,'data','platform')),file=path.join(workspace,'proof.txt');
const {run}=await client.submit({provider:'trae',workspace,task:`用本会话自己的文件工具创建 ${file}，UTF-8 内容严格为两行：\nexecutor=TRAE\nphase=initial\n末尾保留换行。读取文件自检，不修改任何其他业务文件。`,output:'artifacts',idempotencyKey:'desktop-proof-'+path.basename(workspace),timeoutSeconds:600});
console.log('Submitted '+run.id);let current=await client.wait(run.id,{timeoutMs:650000});
if(current.status==='completed'&&current.review==='accepted'&&current.round===2){if(fs.readFileSync(file,'utf8').replaceAll('\r\n','\n')!=='executor=TRAE\nphase=revised\n')throw Error('Previously accepted proof no longer matches');console.log('Existing accepted two-round proof independently rechecked '+run.id);return;}
if(current.status!=='completed')throw Error(JSON.stringify({id:current.id,status:current.status,error:current.error,lastPollError:current.lastPollError}));
const content=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n');if(content!=='executor=TRAE\nphase=initial\n')throw Error('Initial file independent check failed');
console.log('Initial content independently verified; rework same native session');const session=current.sessionId;
await client.rework(run.id,'只将 proof.txt 第二行改为 phase=revised，保持第一行、两行结构和末尾换行。用自己的文件工具修改并读回。');current=await client.wait(run.id,{timeoutMs:650000});
if(current.status!=='completed'||current.sessionId!==session)throw Error('Rework failed or session changed');
const revised=fs.readFileSync(file,'utf8').replaceAll('\r\n','\n');if(revised!=='executor=TRAE\nphase=revised\n')throw Error('Revised file independent check failed');
const accepted=await client.accept(run.id,'实际文件内容与同会话返工已独立核对',[`Read proof.txt: ${JSON.stringify(revised)}`,`Native session remained ${session}; round=${current.round}; runtimeSource=${current.runtimeSource}`]);
fs.writeFileSync(path.join(root,'data','verification','desktop-verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),id:run.id,sessionId:session,round:accepted.round,review:accepted.review,runtimeSource:accepted.runtimeSource,content:revised},null,2));console.log('Verified and accepted '+run.id);
}
main().catch(error=>{console.error(error.message);process.exitCode=1});
