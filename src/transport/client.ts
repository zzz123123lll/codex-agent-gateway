import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HubError, waitingStates, type HubRun, type RunRequestInput} from '../platform/contracts.js';

export interface WaitOptions {timeoutMs?: number; signal?: AbortSignal}
export interface ClientOptions {requestTimeoutMs?:number}
/** Loopback-only client. A wait deadline is observational and never cancels native work. */
export class AgentHubClient {
  readonly url: string;
  readonly requestTimeoutMs:number;
  constructor(url: string, readonly token: string,options:ClientOptions={}) {
    const parsed=new URL(url);
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash) throw new HubError('INVALID_ENDPOINT','Expected a loopback HTTP origin');
    this.url=parsed.origin;
    this.requestTimeoutMs=options.requestTimeoutMs??65000;
    if(!Number.isInteger(this.requestTimeoutMs)||this.requestTimeoutMs<1||this.requestTimeoutMs>2147483647)throw new HubError('INVALID_TIMEOUT','Invalid request timeout');
  }
  static local(directory=process.env.AGENT_HUB_STATE_DIR||fileURLToPath(new URL('../../data/platform/',import.meta.url))): AgentHubClient {
    const data=JSON.parse(fs.readFileSync(path.join(directory,'connection.json'),'utf8'));
    if(typeof data.url!=='string'||typeof data.tokenFile!=='string')throw new HubError('INVALID_CONNECTION','Invalid local connection');
    const tokenFile=path.isAbsolute(data.tokenFile)?data.tokenFile:path.join(directory,data.tokenFile);
    return new AgentHubClient(data.url,fs.readFileSync(tokenFile,'utf8').trim());
  }
  async request<T=any>(route:string,method='GET',data?:unknown,signal?:AbortSignal):Promise<T>{
    if(!route.startsWith('/')||route.startsWith('//')||new URL(route,this.url).origin!==this.url)throw new HubError('INVALID_ROUTE','Expected a relative API route');
    const controller=new AbortController(),abort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(new HubError('REQUEST_TIMEOUT','Gateway request deadline exceeded',408)),this.requestTimeoutMs);
    try{
      const response=await fetch(this.url+route,{method,headers:{authorization:'Bearer '+this.token,...(data===undefined?{}:{'content-type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),redirect:'error',signal:controller.signal});
      let payload:any;try{payload=await response.json()}catch{if(controller.signal.aborted)throw controller.signal.reason;throw new HubError('INVALID_RESPONSE','Gateway returned an invalid response',502)}
      if(!response.ok){const e=payload?.error;throw new HubError(e?.code||'HTTP_ERROR',e?.message||'Gateway request failed',response.status)}
      return payload as T;
    }catch(error){if(controller.signal.aborted)throw controller.signal.reason;throw error}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort)}
  }
  submit(input:RunRequestInput){return this.request<{run:HubRun;created:boolean}>('/v1/runs','POST',input)}
  get(id:string){return this.request<HubRun>('/v1/runs/'+encodeURIComponent(id))}
  events(id:string,after=0){return this.request('/v1/runs/'+encodeURIComponent(id)+'/events?after='+after)}
  cancel(id:string){return this.request<HubRun>('/v1/runs/'+encodeURIComponent(id)+'/cancel','POST',{})}
  rework(id:string,feedback:string){return this.request<HubRun>('/v1/runs/'+encodeURIComponent(id)+'/rework','POST',{feedback})}
  accept(id:string,note:string,evidence:string[]){return this.request<HubRun>('/v1/runs/'+encodeURIComponent(id)+'/accept','POST',{note,evidence})}
  recover(id:string,reason:string){return this.request<HubRun>('/v1/runs/'+encodeURIComponent(id)+'/recover','POST',{reason})}
  async wait(id:string,options:WaitOptions={}):Promise<HubRun>{
    const timeoutMs=options.timeoutMs??1800000;
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw new HubError('INVALID_TIMEOUT','Invalid wait timeout');
    const controller=new AbortController(),deadline=Date.now()+timeoutMs;
    const abort=()=>controller.abort(options.signal?.reason);options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const timer=setTimeout(()=>controller.abort(new HubError('WAIT_TIMEOUT','Wait deadline exceeded',408)),timeoutMs);
    try{
      while(true){
        const seconds=Math.min(50,Math.max(1,Math.ceil((deadline-Date.now())/1000)));
        const run=await this.request<HubRun>('/v1/runs/'+encodeURIComponent(id)+'/wait?timeoutSeconds='+seconds,'GET',undefined,controller.signal);
        if(!waitingStates.has(run.status))return run;
        if(Date.now()>=deadline)throw new HubError('WAIT_TIMEOUT','Wait deadline exceeded',408);
      }
    }finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort)}
  }
  async run(input:RunRequestInput,options:WaitOptions={}){const {run}=await this.submit(input);return this.wait(run.id,options)}
}
