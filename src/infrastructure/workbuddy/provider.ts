import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {HubError,type AgentProvider,type HubRun,type ProviderSnapshot} from '../../platform/contracts.js';
import {verifyWorkBuddyActor} from './actor.js';
import {type WorkBuddyDriver} from './cdp.js';
import {AttemptJournal,attemptProgress,type AttemptRecord,type ExecutionGrant,type ReportStatus} from './journal.js';

type ActorVerifier=(actorPid:number,desktopPid:number,executable:string)=>Promise<boolean>;
const stopped=new Set(['completed','failed','cancelled']);

export class WorkBuddyProvider implements AgentProvider {
  readonly id='workbuddy';readonly label='WorkBuddy desktop';
  readonly capabilities={outputs:['text','json','artifacts'],execution:'native-renderer-rpc',sessionIsolation:'project-session',modelSelection:false,creditUsage:false,cancellation:'confirmed-native-stop',fullToolTrace:false};
  readonly attempts:string;
  private journal:AttemptJournal;
  private server?:http.Server;private origin?:string;private queue:Promise<unknown>=Promise.resolve();
  constructor(readonly directory:string,readonly executable:string,readonly worker:string,readonly driver:WorkBuddyDriver,readonly port=18496,readonly verifyActor:ActorVerifier=verifyWorkBuddyActor){this.journal=new AttemptJournal(directory);this.attempts=this.journal.attempts}
  private serial<T>(operation:()=>Promise<T>):Promise<T>{const next=this.queue.then(operation,operation);this.queue=next.catch(()=>undefined);return next}
  async start(){
    if(this.server)return;
    const server=http.createServer((request,response)=>void this.reportRequest(request,response));
    server.requestTimeout=10000;server.headersTimeout=10000;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()})});
    const address=server.address();if(!address||typeof address==='string')throw new Error('Execution report listener unavailable');
    this.origin='http://127.0.0.1:'+address.port;this.server=server;this.journal.refreshGrantOrigins(this.origin);
  }
  async close(){const server=this.server;this.server=undefined;this.origin=undefined;if(server){server.closeIdleConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}await this.driver.close()}
  async health(){return {state:'configured',message:'Native identity, permissions and availability are checked before each dispatch',usage:{credits:null,source:'unavailable'} as const}}
  private prompt(run:HubRun,attempt:AttemptRecord){
    const grant=this.journal.grant(attempt.id)!;
    const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
    return '[CODEX_QUEUE_WAKE '+attempt.wakeId+']\n目标：'+run.input.task+'\n授权工作目录：'+run.workspace+'\n约束：\n'+run.input.constraints.join('\n')+(run.feedback?'\n本轮返工指示：'+run.feedback:'')+'\n使用此 WorkBuddy 原生会话的模型与工具执行并自检，不绕过登录、工作区信任或工具审批。只修改授权工作目录及本轮结果目录，不修改网关、安全配置或账户。不得仅返回计划或伪造验收。\n完成时写入 UTF-8 JSON 结果文件 '+run.resultFile+'，结构为 {"text":"真实结果、自检证据与遗留问题","json":结构化结果,"artifacts":["成果绝对路径"]}。'+(run.input.output==='json'?'必须包含 json 字段。':'')+(run.input.output==='artifacts'?'至少包含一个真实成果文件。':'无文件时 artifacts=[]。')+'\n然后通过本会话工具运行 Node 帮助程序：node '+quote(this.worker)+' report '+quote(attempt.grantFile)+' completed '+quote(run.resultFile)+'。失败也写真实失败说明并使用 failed；受阻使用 node '+quote(this.worker)+' blocked '+quote(attempt.grantFile)+' "实际受阻原因"；进度使用 progress。执行授权仅属于当前轮次 '+grant.id+'。监督端独立检查后决定验收或同会话返工。';
  }
  async submit(run:HubRun){return this.serial(async()=>{
    const id=this.journal.id(run);
    if(this.journal.get(id))throw new HubError('DISPATCH_UNCERTAIN','This round is already reserved; reconcile its native receipt without replay',409);
    if(!this.origin)throw new HubError('DISPATCH_NOT_SENT','The local execution report listener is offline',503);
    const canonical=fs.realpathSync(run.workspace);
    if(this.journal.all().some(a=>a.holdsCapacity&&path.resolve(a.workspace).toLowerCase()===canonical.toLowerCase()))throw new HubError('DISPATCH_NOT_SENT','An existing native attempt holds this workspace',409);
    let desktopPid:number,sessionId:string;
    try{
      desktopPid=await this.driver.owner();
      sessionId=run.sessionId??this.journal.binding(canonical)??randomUUID();
      if(run.previousAttemptId&&!run.sessionId)throw new Error('Rework requires the previous native session');
      if(run.sessionId||this.journal.binding(canonical)){
        const observation=await this.driver.inspect(sessionId);
        if(observation.state!=='idle')throw new Error('The bound native session is not confirmed idle');
        if(observation.workspace&&path.resolve(observation.workspace).toLowerCase()!==canonical.toLowerCase())throw new Error('The bound native session belongs to another workspace');
      }
    }catch(error){throw new HubError('DISPATCH_NOT_SENT',error instanceof Error?error.message:'Native readiness check failed',409)}
    const now=new Date().toISOString();
    const lease=this.journal.secret();
    const attempt:AttemptRecord={id,runId:run.id,round:run.round,sessionId,wakeId:'wake-run-'+randomUUID(),workspace:canonical,status:'dispatching',holdsCapacity:true,receiptSeen:false,receipt:false,idleCount:0,grantFile:this.journal.grantPath(id),deadline:run.deadline,resultFile:run.resultFile,createdAt:now,updatedAt:now,desktopPid,lease};
    const grant:ExecutionGrant={id,url:this.origin,lease,desktopPid,executable:this.executable,worker:this.worker,sessionId,wakeId:attempt.wakeId,workspace:canonical};
    this.journal.reserve(attempt,grant);
    try{
      if(!run.sessionId&&!this.journal.binding(canonical)){
        const created=await this.driver.create(canonical,sessionId);if(created!==undefined&&created!==sessionId)throw new Error('Native session identity mismatch');
        const initial=await this.driver.inspect(sessionId);
        if(initial.state!=='idle'||initial.workspace&&path.resolve(initial.workspace).toLowerCase()!==canonical.toLowerCase())throw new Error('Created native session is not idle in the authorized workspace');
      }
      this.journal.bind(canonical,sessionId);
      const acknowledged=await this.driver.send(sessionId,attempt.wakeId,this.prompt(run,attempt));
      attempt.receiptSeen=acknowledged!==false&&await this.driver.receipt(sessionId,attempt.wakeId);
      attempt.status=attempt.receiptSeen?'running':'uncertain';
      if(!attempt.receiptSeen)attempt.error='Dispatch receipt missing; no replay is permitted';
      this.journal.save(attempt);
      if(!attempt.receiptSeen)throw new HubError('DISPATCH_UNCERTAIN',attempt.error!,409);
    }catch(error){attempt.status='uncertain';attempt.error=error instanceof Error?error.message:'Native dispatch interrupted';this.journal.save(attempt);throw error}
  })}
  async rework(run:HubRun){if(!run.sessionId)throw new HubError('SESSION_REQUIRED','Same-session rework requires its verified native session',409);await this.submit(run)}
  private snapshot(a:AttemptRecord):ProviderSnapshot {
    return {status:a.status==='dispatching'?'queued':a.status==='uncertain'?'blocked':a.status,holdsCapacity:a.holdsCapacity,attemptId:a.id,sessionId:a.sessionId,runtimeSource:'workbuddy_native_renderer',error:a.error,events:[...attemptProgress(a),...(a.report?[{key:a.id+':report',type:'provider',text:a.report.text}]:[])]};
  }
  async poll(run:HubRun):Promise<ProviderSnapshot|undefined>{return this.serial(async()=>{
    const attempt=this.journal.get(this.journal.id(run));if(!attempt)return undefined;
    attempt.deadline??=run.deadline;attempt.resultFile??=run.resultFile;
    if(!attempt.holdsCapacity)return this.snapshot(attempt);
    try{
      const observation=await this.driver.inspect(attempt.sessionId);
      if(observation.workspace&&path.resolve(observation.workspace).toLowerCase()!==path.resolve(attempt.workspace).toLowerCase())throw new Error('Native session workspace identity changed');
      if(!attempt.receiptSeen)attempt.receiptSeen=await this.driver.receipt(attempt.sessionId,attempt.wakeId);
      const authorized=Boolean(attempt.report)&&attempt.receiptSeen;
      attempt.idleCount=observation.state==='idle'&&(authorized||attempt.cancelRequested)?(attempt.idleCount??0)+1:0;
      if(attempt.idleCount>=3&&(attempt.cancelRequested||(authorized&&stopped.has(attempt.report!.status)))){
        attempt.status=attempt.cancelRequested?'cancelled':attempt.report!.status as 'completed'|'failed'|'cancelled';attempt.holdsCapacity=false;attempt.error=attempt.status==='completed'?undefined:attempt.report?.text;
      }else if(observation.state==='waiting_input'||Date.parse(attempt.deadline)<=Date.now()||attempt.report?.status==='blocked'){
        attempt.status='blocked';attempt.error=observation.reason??attempt.report?.text??'Deadline passed without confirmed native completion';
      }else if(!attempt.receiptSeen){attempt.status='uncertain';attempt.error='Native dispatch receipt is unconfirmed'}else {attempt.status='running';attempt.error=undefined}
    }catch(error){attempt.idleCount=0;attempt.status='uncertain';attempt.error=error instanceof Error?error.message:'Native polling failed'}
    this.journal.save(attempt);return this.snapshot(attempt);
  })}
  async cancel(run:HubRun){return this.serial(async()=>{
    const attempt=this.journal.get(this.journal.id(run));if(!attempt)throw new HubError('ATTEMPT_NOT_FOUND','Native attempt is missing',404);
    if(!attempt.holdsCapacity)return;
    if(attempt.cancelSent)return;
    if(!attempt.cancelRequested)attempt.idleCount=0;
    attempt.cancelRequested=true;this.journal.save(attempt);
    await this.driver.cancel(attempt.sessionId);
    attempt.cancelSent=true;this.journal.save(attempt);
  })}
  async accept(_run:HubRun,_input:{note:string;evidence:string[]}){}
  async recover(run:HubRun,reason:string){return this.serial(async()=>{
    if(!reason.trim())throw new HubError('RECOVERY_REASON_REQUIRED','Describe the checked native recovery',400);
    const attempt=this.journal.get(this.journal.id(run));if(!attempt||!attempt.holdsCapacity)throw new HubError('RECOVERY_NOT_AVAILABLE','A held native attempt is required',409);
    const state=await this.driver.inspect(attempt.sessionId);if(state.state!=='idle'||state.workspace&&path.resolve(state.workspace).toLowerCase()!==path.resolve(attempt.workspace).toLowerCase())throw new HubError('NATIVE_BUSY','Native execution, input or workspace identity remains unconfirmed',409);
    attempt.status=attempt.cancelRequested?'cancelled':'failed';attempt.holdsCapacity=false;attempt.error='Checked recovery: '+reason;attempt.idleCount=0;this.journal.save(attempt);
  })}
  private async reportRequest(request:http.IncomingMessage,response:http.ServerResponse){
    const answer=(status:number,body:unknown)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body))};
    try{
      if(request.method!=='POST'||!['/report','/progress'].includes(request.url??'')){answer(404,{error:'Unknown execution report route'});return}
      if(request.headers.host!==new URL(this.origin!).host||request.headers.origin||request.headers['content-type']?.split(';')[0]!=='application/json'){answer(403,{error:'Invalid report origin or content type'});return}
      let size=0,tooLarge=false;const chunks:Buffer[]=[];
      for await(const value of request){const chunk=Buffer.from(value);size+=chunk.length;if(size>128*1024){tooLarge=true;continue}chunks.push(chunk)}
      if(tooLarge){answer(413,{error:'Execution report exceeds its limit'});return}
      let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{answer(400,{error:'Invalid report JSON'});return}
      if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.id!=='string'||!Number.isSafeInteger(body.actorPid)||body.actorPid<=0||typeof body.text!=='string'||!body.text.trim()||body.text.length>60000){answer(400,{error:'Invalid report fields'});return}
      const result=await this.serial(async()=>{
        const grant=this.journal.grant(body.id),attempt=this.journal.get(body.id);
        const supplied=String(request.headers.authorization??'').replace(/^Bearer /,'');
        if(!grant||!attempt||supplied.length!==grant.lease.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(grant.lease))||!await this.verifyActor(body.actorPid,grant.desktopPid,grant.executable))return {code:403,data:{error:'Execution grant or process lineage rejected'}};
        if(request.url==='/progress'){
          if(attempt.report||!attempt.holdsCapacity)return {code:409,data:{error:'Attempt no longer accepts progress'}};
          const key=attempt.id+':progress:'+createHash('sha256').update(body.text).digest('hex');
          attempt.progressEvents??=[];if(!attemptProgress(attempt).some(event=>event.key===key))attempt.progressEvents.push({key,type:'provider',text:body.text});
          if(attempt.progressEvents.length>100)attempt.progressEvents=attempt.progressEvents.slice(-100);
          this.journal.save(attempt);return {code:200,data:{ok:true}};
        }
        if(!['completed','failed','cancelled','blocked'].includes(body.status))return {code:400,data:{error:'Unsupported executor report status'}};
        if(attempt.report){const equal=attempt.report.status===body.status&&attempt.report.text===body.text;return {code:equal?200:409,data:equal?{ok:true,duplicate:true}:{error:'The first report is immutable'}}}
        if(!attempt.holdsCapacity)return {code:409,data:{error:'Attempt has already ended'}};
        attempt.report={status:body.status as ReportStatus,text:body.text};attempt.idleCount=0;this.journal.save(attempt);return {code:200,data:{ok:true}};
      });answer(result.code,result.data);
    }catch(error){answer(error instanceof HubError?error.httpStatus:400,{error:'Execution report was rejected'})}
  }
}
