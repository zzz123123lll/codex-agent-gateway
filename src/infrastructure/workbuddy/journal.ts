import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,randomUUID,createHash} from 'node:crypto';

export type ReportStatus='completed'|'failed'|'cancelled'|'blocked';
export interface ExecutionGrant {id:string;url:string;lease:string;desktopPid:number;executable:string;worker:string;sessionId:string;wakeId:string;workspace:string}
export interface AttemptRecord {
  id:string;runId:string;round:number;sessionId:string;wakeId:string;workspace:string;
  status:'dispatching'|'running'|'completed'|'failed'|'cancelled'|'blocked'|'uncertain';
  holdsCapacity:boolean;receiptSeen:boolean;idleCount:number;cancelRequested?:boolean;cancelSent?:boolean;
  report?:{status:ReportStatus;text:string};progress?:string|Array<{key:string;type:string;text:string}>;
  progressEvents?:Array<{key:string;type:string;text:string}>;
  grantFile:string;deadline:string;resultFile:string;createdAt:string;updatedAt:string;error?:string;
  desktopPid?:number;lease?:string;receipt?:boolean;
}
export function attemptProgress(attempt:AttemptRecord):Array<{key:string;type:string;text:string}> {
  const old=typeof attempt.progress==='string'?[{key:attempt.id+':progress:'+createHash('sha256').update(attempt.progress).digest('hex'),type:'provider',text:attempt.progress}]:Array.isArray(attempt.progress)?attempt.progress:[];
  const candidates=[...old,...(attempt.progressEvents??[])].filter(event=>typeof event?.key==='string'&&typeof event?.text==='string'&&typeof event?.type==='string');
  return [...new Map(candidates.map(event=>[event.key,event])).values()];
}
export function persistJson(file:string,value:unknown,exclusive=false){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(exclusive){fs.writeFileSync(file,JSON.stringify(value),{flag:'wx',mode:0o600});return}
  const staging=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(staging,JSON.stringify(value),{flag:'wx',mode:0o600});fs.renameSync(staging,file)}finally{if(fs.existsSync(staging))fs.unlinkSync(staging)}
}
export class AttemptJournal {
  readonly attempts:string;readonly grants:string;readonly bindings:string;
  constructor(readonly directory:string){
    this.attempts=path.join(directory,'workbuddy','attempts');this.grants=this.attempts;this.bindings=path.join(directory,'workbuddy','projects');
    for(const location of [this.attempts,this.grants,this.bindings])fs.mkdirSync(location,{recursive:true});
  }
  id(run:{id:string;round:number}){if(!/^hub-[a-zA-Z0-9-]+$/.test(run.id)||!Number.isSafeInteger(run.round)||run.round<1)throw new Error('Invalid execution identity');return run.id+'-round-'+run.round}
  private file(id:string){if(!/^[a-zA-Z0-9-]+$/.test(id))throw new Error('Invalid attempt identity');return path.join(this.attempts,id+'.json')}
  get(id:string):AttemptRecord|undefined {
    try{
      const value=JSON.parse(fs.readFileSync(this.file(id),'utf8'));
      const match=id.match(/^(hub-[a-zA-Z0-9-]+)-round-(\d+)$/);
      const terminal=['completed','failed','cancelled'].includes(value.status);
      return {...value,id,runId:value.runId??match?.[1],round:value.round??Number(match?.[2]),status:value.status==='reserved'?'dispatching':value.status,holdsCapacity:value.holdsCapacity??!terminal,receiptSeen:value.receiptSeen??(value.receipt===true),idleCount:value.idleCount??0,grantFile:value.grantFile??this.grantPath(id)};
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
  }
  all(){return fs.readdirSync(this.attempts).filter(name=>name.endsWith('.json')&&!name.endsWith('.grant.json')).map(name=>this.get(name.slice(0,-5))!).filter(Boolean)}
  save(attempt:AttemptRecord){attempt.updatedAt=new Date().toISOString();attempt.receipt=attempt.receiptSeen;persistJson(this.file(attempt.id),attempt)}
  reserve(attempt:AttemptRecord,grant:ExecutionGrant){
    // A durable reservation must exist even if writing the execution grant fails.
    persistJson(this.file(attempt.id),attempt,true);persistJson(attempt.grantFile,grant,true);
  }
  grant(id:string):ExecutionGrant|undefined {const attempt=this.get(id);if(!attempt)return undefined;try{return JSON.parse(fs.readFileSync(attempt.grantFile,'utf8'))}catch{return undefined}}
  refreshGrantOrigins(origin:string){for(const attempt of this.all()){if(!attempt.holdsCapacity)continue;const grant=this.grant(attempt.id);if(grant)persistJson(attempt.grantFile,{...grant,url:origin})}}
  private bindingFile(workspace:string){const key=createHash('sha256').update(fs.realpathSync(workspace).toLowerCase()).digest('hex');return path.join(this.bindings,key+'.json')}
  binding(workspace:string):string|undefined {try{const value=JSON.parse(fs.readFileSync(this.bindingFile(workspace),'utf8'));return value.sessionId}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}}
  bind(workspace:string,sessionId:string){persistJson(this.bindingFile(workspace),{workspace,sessionId})}
  grantPath(id:string){return path.join(this.grants,id+'.grant.json')}
  secret(){return randomBytes(32).toString('hex')}
}
