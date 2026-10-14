'use strict';
const vscode=require('vscode'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{execFile}=require('node:child_process');
const runProcess=(exe,args,options)=>new Promise((resolve,reject)=>execFile(exe,args,options,(error,stdout)=>error?reject(error):resolve({stdout})));
// Ordinary desktop integration; do not call the account-restricted evaluation sender.
const SEND='icube.chat.sendToAgentNonBlocking',STATUS='icube.chat.getSessionRunningStatus',STOP='icube.chat.stopSession',CURRENT='icube.chat.getCurrentSessionId';
const terminal=new Set(['completed','failed','cancelled']);
const deadlineError='Deadline passed without both verified report and native stop';
// A deadline is an observation failure, not proof that the original execution ended.
const observable=a=>!!a.sessionId&&(a.status==='running'||a.status==='uncertain'&&(a.uncertaintyReason==='deadline'||!a.uncertaintyReason&&a.error===deadlineError));
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}
function same(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
async function ancestry(pid){
 if(!Number.isInteger(pid)||pid<1)throw Error('Invalid actor PID');
 const script=`$p=${pid};$r=@();for($i=0;$i -lt 40 -and $p -gt 0;$i++){$v=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p);if(!$v){break};$r+=@{pid=[int]$v.ProcessId;parent=[int]$v.ParentProcessId;exe=$v.ExecutablePath};if($p -eq [int]$v.ParentProcessId){break};$p=[int]$v.ParentProcessId};ConvertTo-Json -InputObject @($r) -Compress`;
 return JSON.parse((await runProcess('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000})).stdout);
}
function activate(context){
 const folders=vscode.workspace.workspaceFolders??[];if(folders.length!==1||folders[0].uri.scheme!=='file')return;
 const configFile=path.join(context.globalStorageUri.fsPath,'gateway.json');if(!fs.existsSync(configFile))return;
 const config=JSON.parse(fs.readFileSync(configFile,'utf8')),directory=path.resolve(config.stateDirectory),workspace=fs.realpathSync(folders[0].uri.fsPath);
 const key=crypto.createHash('sha256').update(workspace.toLowerCase()).digest('hex'),journal=path.join(directory,'desktop-attempts',key),registration=path.join(directory,'bridges',key+'.json');fs.mkdirSync(journal,{recursive:true});
 const token=crypto.randomBytes(32).toString('hex'),instance=crypto.randomUUID();let commands=[],disposed=false,busy=false,submitting=false;
 const ownership=path.join(journal,'bridge.owner');
 if(fs.existsSync(ownership)){const old=JSON.parse(fs.readFileSync(ownership,'utf8'));if(Number.isSafeInteger(old.pid)&&old.pid>0){try{process.kill(old.pid,0);return;}catch{}}fs.unlinkSync(ownership);}
 fs.writeFileSync(ownership,JSON.stringify({pid:process.pid,instance}),{flag:'wx'});
 const read=id=>{if(!/^hub-[a-f0-9-]{36}-round-\d+$/.test(id))throw Error('Invalid attempt id');const file=path.join(journal,id+'.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):undefined;};
 const save=a=>write(path.join(journal,a.id+'.json'),a),all=()=>fs.readdirSync(journal).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(journal,n),'utf8')));
 for(const a of all())if(['dispatching','running'].includes(a.status)){a.status='uncertain';a.uncertaintyReason='bridge_restart';a.error='Desktop bridge restarted during an open attempt; inspect before recovery';save(a);}
 const output=vscode.window.createOutputChannel('Codex TRAE Bridge');context.subscriptions.push(output);
 const server=http.createServer(async(req,res)=>{
  const json=(code,data)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
  let acquired=false;try{
   const port=server.address().port;if(req.headers.host!==`127.0.0.1:${port}`||req.headers.origin)return json(403,{error:'Loopback program access only'});
   const route=new URL(req.url,'http://127.0.0.1');let input;
   if(req.method==='POST'){if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'Use JSON'});let size=0,chunks=[];for await(const c of req){size+=c.length;if(size>1048576)throw Error('Request too large');chunks.push(c);}input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
   const bearer=(req.headers.authorization??'').replace(/^Bearer /,'');
   if(['/report','/progress'].includes(route.pathname)){
    if(req.method!=='POST')return json(405,{error:'Use POST'});const a=read(input.id);
    if(!a||!same(crypto.createHash('sha256').update(bearer).digest('hex'),a.leaseHash)||terminal.has(a.status))return json(403,{error:'Invalid or closed lease'});
    const chain=await ancestry(input.actorPid);
    if(chain[0]?.pid!==input.actorPid||!chain[0]?.exe||path.resolve(chain[0].exe).toLowerCase()!==path.resolve(config.nodePath).toLowerCase()||!chain.some(p=>p.pid===a.desktopPid&&p.exe&&path.resolve(p.exe).toLowerCase()===path.resolve(config.executable).toLowerCase()))return json(403,{error:'Caller is not a Node tool process descended from the registered TRAE desktop'});
    const fresh=read(input.id);if(!fresh||terminal.has(fresh.status))return json(403,{error:'Lease closed during verification'});Object.assign(a,fresh);
    if(typeof input.text!=='string'||!input.text.trim())throw Error('Real text required');
    if(route.pathname==='/progress'){a.progress=input.text.slice(0,8000);a.progressAt=new Date().toISOString();save(a);return json(200,{ok:true,cancellationRequested:!!a.cancelRequested});}
    if(!['completed','failed','blocked','cancelled'].includes(input.status))throw Error('Invalid report state');
    if(a.report){if(a.report.status===input.status&&a.report.text===input.text.slice(0,32000)&&a.report.actorPid===input.actorPid)return json(200,{ok:true,duplicate:true});return json(409,{error:'A different report already exists for this attempt'});}
    a.report={status:input.status,text:input.text.slice(0,32000),actorPid:input.actorPid,receivedAt:new Date().toISOString()};a.idleCount=0;save(a);return json(200,{ok:true,cancellationRequested:!!a.cancelRequested,nativeStopStillRequired:true});
   }
   if(!same(bearer,token))return json(401,{error:'Unauthorized'});
   if(req.method==='GET'&&route.pathname==='/health')return json(200,{workspace,commands,version:vscode.version,pid:process.pid,currentSessionId:await vscode.commands.executeCommand(CURRENT)});
   if(req.method==='GET'&&route.pathname.startsWith('/attempt/'))return json(200,read(decodeURIComponent(route.pathname.slice(9)))??null);
   if(req.method!=='POST'||!['/submit','/cancel','/recover'].includes(route.pathname))return json(404,{error:'Unknown endpoint'});let a=read(input.id);
   if(route.pathname==='/cancel'){
    if(!a)return json(404,{error:'Unknown attempt'});if(terminal.has(a.status))return json(200,a);a.cancelRequested=true;save(a);
    if(a.sessionId){await vscode.commands.executeCommand(STOP,{sessionId:a.sessionId});a=read(a.id);a.nativeStatus=await vscode.commands.executeCommand(STATUS,{sessionId:a.sessionId});if(a.nativeStatus==='WaitingInput'){a.status='cancelled';a.evidence='Native stop acknowledged and original session confirmed idle';save(a);}}
    return json(200,a);
   }
   if(route.pathname==='/recover'){
    if(!a||a.status!=='uncertain'||!a.sessionId||!input.reason?.trim())return json(409,{error:'Uncertain attempt, original session and inspection reason required'});
    if(await vscode.commands.executeCommand(STATUS,{sessionId:a.sessionId})!=='WaitingInput')return json(409,{error:'Original native session is not idle'});
    a.status='failed';a.error='Interrupted execution inspected: '+input.reason;a.evidence='Native idle verified; task neither accepted nor resent';save(a);return json(200,a);
   }
   if(a)return json(200,a);if(submitting)return json(409,{error:'Project dispatch transaction already in progress'});submitting=true;acquired=true;if(!vscode.workspace.isTrusted)return json(409,{error:'TRAE project trust required'});
   commands=await vscode.commands.getCommands(true);if(![SEND,STATUS,STOP,CURRENT].every(c=>commands.includes(c)))return json(409,{error:'Native commands incompatible'});
   if(typeof input.prompt!=='string'||!input.prompt.includes(`[CODEX_TRAE_TASK ${input.id}]`)||!Number.isFinite(Date.parse(input.deadline))||Date.parse(input.deadline)<=Date.now())throw Error('Invalid prompt or deadline');
   if(typeof input.resultFile!=='string'||!path.isAbsolute(input.resultFile)||!path.resolve(input.resultFile).toLowerCase().startsWith(path.join(directory,'results').toLowerCase()+path.sep))throw Error('Result outside gateway directory');
   if(all().some(x=>['dispatching','running','uncertain'].includes(x.status)))return json(409,{error:'Project has an unfinished attempt'});
   if(input.sessionId){if(await vscode.commands.executeCommand(CURRENT)!==input.sessionId)return json(409,{error:'Original worker session is not selected; no prompt sent'});if(await vscode.commands.executeCommand(STATUS,{sessionId:input.sessionId})!=='WaitingInput')return json(409,{error:'Original session is not idle'});}
   const lease=crypto.randomBytes(32).toString('hex');a={id:input.id,status:'dispatching',sessionId:input.sessionId,workspace,instance,desktopPid:process.ppid,leaseHash:crypto.createHash('sha256').update(lease).digest('hex'),createdAt:new Date().toISOString(),deadline:input.deadline};save(a);
   const grantFile=path.join(directory,'leases',a.id+'.json');write(grantFile,{url:`http://127.0.0.1:${port}`,lease,id:a.id,workspace,desktopPid:a.desktopPid,executable:config.executable});
   const q=s=>"'"+s.replaceAll("'","''")+"'";
   const command=`& ${q(config.nodePath)} ${q(config.workerPath)} report ${q(grantFile)} completed ${q(input.resultFile)}`;
   const prompt=input.prompt+`\n创建结果文件后，必须使用本 TRAE 会话自己的终端工具执行本轮回报命令（PowerShell）：\n${command}\nhelper 只核对执行来源并回报，不替你生成成果。受阻时运行：& ${q(config.nodePath)} ${q(config.workerPath)} blocked ${q(grantFile)} '具体阻塞原因'。不要改 helper 或执行凭证，回报后结束回复。`;
   json(202,a);void(async()=>{try{const receipt=await vscode.commands.executeCommand(SEND,[prompt],{newSession:!input.sessionId});a=read(input.id);if(!receipt?.sessionId||input.sessionId&&receipt.sessionId!==input.sessionId)throw Error('Native receipt mismatched or uncertain');a.sessionId=receipt.sessionId;if(!terminal.has(a.status))a.status='running';a.sentAt=new Date().toISOString();save(a);if(a.cancelRequested&&!terminal.has(a.status)){await vscode.commands.executeCommand(STOP,{sessionId:a.sessionId});a=read(input.id);a.nativeStatus=await vscode.commands.executeCommand(STATUS,{sessionId:a.sessionId});if(a.nativeStatus==='WaitingInput'){a.status='cancelled';a.evidence='Native stop acknowledged after receipt; original session confirmed idle';save(a);}}}catch(error){a=read(input.id);if(!terminal.has(a.status)){a.status='uncertain';a.error=error.message;save(a);}output.appendLine('Uncertain: '+error.message);}})();
  }catch(error){if(!res.headersSent)json(400,{error:error.message});else res.destroy();}finally{if(acquired)submitting=false;}
 });
 async function observe(){if(disposed||busy)return;busy=true;try{for(let a of all().filter(observable)){const reportAtRequest=JSON.stringify(a.report??null);let state;try{state=await vscode.commands.executeCommand(STATUS,{sessionId:a.sessionId});}catch(error){a=read(a.id);if(observable(a)){a.idleCount=0;a.lastObservationError='Native status unavailable';save(a);}continue;}a=read(a.id);if(!observable(a))continue;a.nativeStatus=state;a.nativeObservedAt=new Date().toISOString();delete a.lastObservationError;const reportUnchanged=reportAtRequest===JSON.stringify(a.report??null);a.idleCount=a.report&&reportUnchanged&&state==='WaitingInput'?(a.idleCount??0)+1:0;
  if(a.report&&a.idleCount>=3){a.status=a.cancelRequested||a.report.status==='cancelled'?'cancelled':a.report.status==='completed'?'completed':'failed';a.completedAt=new Date().toISOString();a.error=a.status==='failed'?a.report.text:undefined;a.evidence=`TRAE ${vscode.version}; session=${a.sessionId}; verified desktop actor=${a.report.actorPid}; lease matched; report=${a.report.status}; native end=${state}`;}
  else if(Date.parse(a.deadline)<Date.now()){a.status='uncertain';a.uncertaintyReason='deadline';a.error=deadlineError;}save(a);
 }}catch(error){output.appendLine('Observation: '+error.message);}finally{busy=false;}}
 function heartbeat(){if(disposed||!server.address())return;write(registration,{url:`http://127.0.0.1:${server.address().port}`,token,workspace,pid:process.pid,instance,updatedAt:new Date().toISOString(),commands:commands.filter(c=>[SEND,STATUS,STOP,CURRENT].includes(c)),version:vscode.version});}
 server.listen(0,'127.0.0.1',async()=>{commands=await vscode.commands.getCommands(true);heartbeat();});const timer=setInterval(()=>{heartbeat();void observe();},1000);
 context.subscriptions.push(vscode.commands.registerCommand('codexTraeBridge.status',()=>vscode.window.showInformationMessage('Codex TRAE Bridge: '+workspace)));
 context.subscriptions.push({dispose(){disposed=true;clearInterval(timer);server.close();server.closeAllConnections();try{if(JSON.parse(fs.readFileSync(registration,'utf8')).instance===instance)fs.unlinkSync(registration);}catch{}try{if(JSON.parse(fs.readFileSync(ownership,'utf8')).instance===instance)fs.unlinkSync(ownership);}catch{}}});
}
module.exports={activate};
