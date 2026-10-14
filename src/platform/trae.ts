import fs from 'node:fs';
import path from 'node:path';
import { TraeDesktop, type Attempt } from '../desktop.js';
import { HubError, type AgentProvider, type HubRun, type ProviderSnapshot } from './contracts.js';

export class TraeProvider implements AgentProvider {
  readonly id='trae'; readonly label='TRAE desktop';
  readonly capabilities={outputs:['text','json','artifacts'],execution:'native-desktop-extension',sessionIsolation:'project-window',modelSelection:false,creditUsage:false,cancellation:'confirmed-native-stop',fullToolTrace:false};
  constructor(readonly desktop: TraeDesktop) {}
  async health(){return {state:'configured',message:'Desktop connection, login, permissions and model availability are confirmed per project during execution',usage:{credits:null,source:'unavailable'} as const};}
  private attemptId(run:HubRun){return `${run.id}-round-${run.round}`;}
  private reservation(run:HubRun){return path.join(this.desktop.directory,'dispatch',this.attemptId(run)+'.json');}
  private prompt(run:HubRun){return `[CODEX_TRAE_TASK ${this.attemptId(run)}]\n目标：${run.input.task}\n工作目录：${run.workspace}\n约束：${run.input.constraints.join('\n')}\n${run.feedback?'本轮返工意见：'+run.feedback:''}\n请使用本 TRAE 桌面会话的模型、工具和技能实际执行并自检。只修改授权工作目录和结果目录；不要修改网关、配置、安全设置或记忆。不要仅给计划；需要权限或输入则如实说明，不绕过审批。\n完成后用你的文件工具创建 ${run.resultFile}，父目录已准备好。内容必须是 UTF-8 JSON：{"text":"真实结果及未解决问题","json":任意JSON值,"artifacts":["真实成果绝对路径"]}。${run.input.output==='json'?'json 必须包含要求的结构化结果。':''}${run.input.output==='artifacts'?'artifacts 至少一个真实文件。':'无文件则 artifacts=[]。'}成果只能位于本任务工作目录或结果目录，不把结果文件本身列入 artifacts。失败或受阻时不要创建冒充成功的结果。完成后简短回报实际修改、自检证据及结果文件路径。`}
  async submit(run:HubRun){
    try { await this.desktop.ensure(run.workspace); }
    catch(error) { throw new HubError('DISPATCH_NOT_SENT',error instanceof Error?error.message:String(error)); }
    const file=this.reservation(run);fs.mkdirSync(path.dirname(file),{recursive:true});
    // Persist before the first side effect. Any uncertain send must be reconciled, never replayed.
    if(fs.existsSync(file))throw Error('Dispatch already reserved; reconcile existing desktop receipt');
    fs.writeFileSync(file,JSON.stringify({workspace:run.workspace,id:this.attemptId(run),reservedAt:new Date().toISOString()}),{flag:'wx'});
    try { await this.desktop.request(run.workspace,'/submit',{id:this.attemptId(run),prompt:this.prompt(run),deadline:run.deadline,resultFile:run.resultFile,sessionId:run.round>1?run.sessionId:undefined}); }
    catch(error) { if(error instanceof HubError && error.code==='DESKTOP_ERROR'&&error.httpStatus>=400&&error.httpStatus<500)throw new HubError('DISPATCH_NOT_SENT',error.message);throw error; }
  }
  async rework(run:HubRun){if(!run.sessionId)throw Error('Same-session rework requires a verified native session');await this.submit(run);}
  async poll(run:HubRun):Promise<ProviderSnapshot|undefined>{
    if(!fs.existsSync(this.reservation(run)))return undefined;
    const a=await this.desktop.request<Attempt|undefined>(run.workspace,'/attempt/'+encodeURIComponent(this.attemptId(run)));
    if(!a)return undefined;
    if(a.status==='uncertain')return {status:'blocked',holdsCapacity:true,attemptId:a.id,sessionId:a.sessionId,runtimeSource:'trae_desktop_extension',error:a.error??'Native dispatch uncertain; inspect before checked recovery',events:[]};
    if(Date.parse(run.deadline)<=Date.now()&&!['completed','failed','cancelled'].includes(a.status))return {status:'blocked',holdsCapacity:true,attemptId:a.id,sessionId:a.sessionId,runtimeSource:'trae_desktop_extension',error:'Deadline passed without confirmed native completion; inspect permissions or cancel',events:[]};
    const terminal=['completed','failed','cancelled'].includes(a.status);
    return {status:a.status==='dispatching'?'queued':a.status==='running'?'running':a.status==='completed'?'completed':a.status==='cancelled'?'cancelled':'failed',holdsCapacity:!terminal,attemptId:a.id,sessionId:a.sessionId,runtimeSource:'trae_desktop_extension',error:a.error,events:a.evidence?[{key:a.id+':native-result',type:'provider',text:a.evidence}]:[]};
  }
  async cancel(run:HubRun){await this.desktop.request(run.workspace,'/cancel',{id:this.attemptId(run)});}
  async accept(_run:HubRun,_input:{note:string;evidence:string[]}){}
  async recover(run:HubRun,reason:string){await this.desktop.request(run.workspace,'/recover',{id:this.attemptId(run),reason});}
}
