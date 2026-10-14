import http,{type IncomingMessage,type ServerResponse} from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {HubError,requestSchema,waitingStates,type HubRun} from '../platform/contracts.js';
import type {HubEngine} from '../platform/engine.js';
import {dashboardHtml} from './ui.js';
import {packageVersion} from '../runtime/settings.js';

const SIZE=1048576;
const note=z.string().trim().min(1).max(100000);
const bodies={cancel:z.object({}).strict(),rework:z.object({feedback:note}).strict(),accept:z.object({note,evidence:z.array(z.string().trim().min(1).max(100000)).min(1).max(100)}).strict(),recover:z.object({reason:note}).strict()};
function compare(a:string,b:string){return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest())}
function send(res:ServerResponse,status:number,payload:unknown){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(payload))}
function integer(value:string|null,fallback:number,minimum=0,maximum=Number.MAX_SAFE_INTEGER){if(value===null)return fallback;if(!/^\d+$/.test(value))throw new HubError('INVALID_PARAMETER','Invalid integer parameter');const n=Number(value);if(!Number.isSafeInteger(n)||n<minimum||n>maximum)throw new HubError('INVALID_PARAMETER','Integer parameter out of range');return n}
function bad(code:string,message:string,status=400){return new HubError(code,message,status)}
async function body(req:IncomingMessage){
  if(!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||''))throw bad('UNSUPPORTED_MEDIA_TYPE','Expected application/json',415);
  const declared=Number(req.headers['content-length']||0);if(declared>SIZE){req.resume();throw bad('BODY_TOO_LARGE','Request body too large',413)}
  const chunks:Buffer[]=[];let length=0;
  await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{req.removeListener('data',data);req.removeListener('end',end);req.removeListener('error',error);req.removeListener('aborted',abort)};
    const data=(chunk:Buffer)=>{length+=chunk.length;if(length>SIZE){cleanup();req.resume();reject(bad('BODY_TOO_LARGE','Request body too large',413));return}chunks.push(chunk)};
    const end=()=>{cleanup();resolve()};const error=()=>{cleanup();reject(bad('INVALID_BODY','Unable to read request'))};const abort=()=>{cleanup();reject(bad('INVALID_BODY','Request was interrupted'))};
    req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',abort);
  });
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw bad('INVALID_JSON','Malformed JSON request')}
}
function localBoundary(req:IncomingMessage){
  const host='127.0.0.1:'+req.socket.localPort;
  if(req.socket.remoteAddress!=='127.0.0.1'&&req.socket.remoteAddress!=='::ffff:127.0.0.1')throw bad('INVALID_PEER','Loopback access required',403);
  if(req.headers.host!==host)throw bad('INVALID_HOST','Invalid request host',403);
  if(req.headers.origin!==undefined&&req.headers.origin!=='http://'+host)throw bad('INVALID_ORIGIN','Cross-site request rejected',403);
  if(req.headers['sec-fetch-site']==='cross-site')throw bad('INVALID_ORIGIN','Cross-site request rejected',403);
}
function authenticated(req:IncomingMessage,token:string){
  const authorization=req.headers.authorization;
  if(authorization!==undefined)return authorization.startsWith('Bearer ')&&compare(authorization.slice(7),token);
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('agent_hub='));
  if(!cookie)return false;try{return compare(decodeURIComponent(cookie.slice(10)),token)}catch{return false}
}
function canonical(p:string){return process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p)}
function contained(root:string,target:string){const rel=path.relative(canonical(root),canonical(target));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))}
/** The descriptor is opened once, checked and streamed without reopening the pathname. */
async function download(engine:HubEngine,id:string,index:number,res:ServerResponse){
  const run=engine.get(id),artifact=run.result?.artifacts[index];
  if(!artifact)throw bad('ARTIFACT_NOT_FOUND','Artifact not found',404);
  let fd:number|undefined;
  try{
    const target=fs.realpathSync(artifact.path),roots=[run.workspace,path.dirname(run.resultFile)];
    if(canonical(target)!==canonical(artifact.path)||!roots.some(root=>canonical(fs.realpathSync(root))===canonical(root)&&contained(root,target)))throw bad('OUTPUT_CHANGED','Artifact location changed',409);
    fd=fs.openSync(target,'r');const stat=fs.fstatSync(fd),current=fs.statSync(fs.realpathSync(artifact.path));
    if(!stat.isFile()||stat.dev!==current.dev||stat.ino!==current.ino||stat.size!==artifact.bytes)throw bad('OUTPUT_CHANGED','Artifact changed since completion',409);
    const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(65536);let position=0;
    while(true){const count=fs.readSync(fd,chunk,0,chunk.length,position);if(count===0)break;digest.update(chunk.subarray(0,count));position+=count}
    const after=fs.fstatSync(fd);
    if(position!==artifact.bytes||digest.digest('hex')!==artifact.sha256||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw bad('OUTPUT_CHANGED','Artifact changed since completion',409);
    const filename=encodeURIComponent(artifact.name||path.basename(target));
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':String(stat.size),'content-disposition':"attachment; filename*=UTF-8''"+filename,'cache-control':'no-store','x-content-type-options':'nosniff'});
    const stream=fs.createReadStream(target,{fd,autoClose:true,start:0});fd=undefined;
    res.once('close',()=>stream.destroy());stream.once('error',()=>res.destroy());stream.pipe(res);
  }catch(error){if(error instanceof HubError)throw error;throw bad('OUTPUT_CHANGED','Artifact unavailable or changed',409)}finally{if(fd!==undefined)fs.closeSync(fd)}
}
function observeWait(engine:HubEngine,id:string,seconds:number,res:ServerResponse){
  const deadline=Date.now()+seconds*1000;let timer:NodeJS.Timeout|undefined;
  const cleanup=()=>{if(timer)clearTimeout(timer)};res.once('close',cleanup);
  const poll=()=>{if(res.destroyed)return;try{const run=engine.get(id);if(!waitingStates.has(run.status)||Date.now()>=deadline){cleanup();res.removeListener('close',cleanup);send(res,200,run);return}timer=setTimeout(poll,Math.min(200,Math.max(1,deadline-Date.now())))}catch{cleanup();send(res,404,{error:{code:'RUN_NOT_FOUND',message:'Task is no longer available'}})}};poll();
}
function observeStream(engine:HubEngine,id:string,after:number,res:ServerResponse){
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store','connection':'keep-alive','x-accel-buffering':'no'});
  let cursor=after,lastState='',lastBeat=Date.now();
  const pump=()=>{
    if(res.destroyed||res.writableNeedDrain)return;
    try{
      const run=engine.get(id),state=JSON.stringify(run);
      if(state!==lastState){res.write('event: state\ndata: '+state+'\n\n');lastState=state}
      for(const event of engine.store.events(id,cursor,100)){
        res.write('id: '+event.id+'\nevent: audit\ndata: '+JSON.stringify(event)+'\n\n');cursor=event.id;
      }
      if(Date.now()-lastBeat>=15000){res.write(': heartbeat\n\n');lastBeat=Date.now()}
    }catch{res.end()}
  };
  const timer=setInterval(pump,250);const stop=()=>clearInterval(timer);res.once('close',stop);res.once('finish',stop);pump();
}
export function createHubServer(engine:HubEngine,token:string):http.Server{
  if(!token)throw bad('INVALID_TOKEN','Gateway token is required');
  return http.createServer((req,res)=>{void (async()=>{
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    localBoundary(req);
    const url=new URL(req.url||'/','http://'+req.headers.host),auth=authenticated(req,token);
    if(auth&&req.headers.authorization)res.setHeader('set-cookie','agent_hub='+encodeURIComponent(token)+'; HttpOnly; SameSite=Strict; Path=/');
    if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"});res.end(dashboardHtml());return}
    if(!auth)throw bad('UNAUTHORIZED','Authentication required',401);
    if(req.method==='GET'&&url.pathname==='/v1/health'){send(res,200,{ok:true,version:packageVersion,maxConcurrent:engine.maxConcurrent});return}
    if(req.method==='GET'&&url.pathname==='/v1/providers'){send(res,200,{providers:await engine.describeProviders()});return}
    if(url.pathname==='/v1/runs'){
      if(req.method==='GET'){send(res,200,{runs:engine.store.list(integer(url.searchParams.get('limit'),100,1,100),integer(url.searchParams.get('offset'),0))});return}
      if(req.method==='POST'){const input=requestSchema.parse(await body(req)),result=engine.submit(input);send(res,result.created?202:200,result);return}
    }
    const match=/^\/v1\/runs\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(url.pathname);
    if(!match)throw bad('NOT_FOUND','Route not found',404);
    let id:string;try{id=decodeURIComponent(match[1]!)}catch{throw bad('INVALID_PARAMETER','Invalid run identifier')}
    engine.get(id);
    const action=match[2];
    if(req.method==='GET'){
      if(match[3]&&action!=='artifacts')throw bad('NOT_FOUND','Route not found',404);
      if(!action){send(res,200,engine.get(id));return}
      if(action==='events'){send(res,200,{events:engine.store.events(id,integer(url.searchParams.get('after'),0),100)});return}
      if(action==='wait'){
        const raw=url.searchParams.get('timeoutSeconds'),seconds=raw===null?45:Number(raw);
        if(raw===''||!Number.isFinite(seconds)||seconds<=0||seconds>50)throw bad('INVALID_PARAMETER','Wait must be greater than zero and at most 50 seconds');
        observeWait(engine,id,seconds,res);return;
      }
      if(action==='stream'){const cursor=url.searchParams.get('after')??(typeof req.headers['last-event-id']==='string'?req.headers['last-event-id']:null);observeStream(engine,id,integer(cursor,0),res);return}
      if(action==='artifacts'){await download(engine,id,integer(match[3]??null,-1,0),res);return}
    }
    if(req.method==='POST'&&action&&Object.hasOwn(bodies,action)&&!match[3]){
      const data:any=bodies[action as keyof typeof bodies].parse(await body(req));let run:HubRun;
      if(action==='cancel')run=await engine.cancel(id);
      else if(action==='rework')run=await engine.rework(id,data.feedback);
      else if(action==='accept')run=await engine.accept(id,data);
      else run=await engine.recover(id,data.reason);
      send(res,action==='rework'?202:200,run);return;
    }
    throw bad('NOT_FOUND','Route not found',404);
  })().catch(error=>{
    if(res.headersSent){res.destroy();return}
    if(error instanceof z.ZodError){send(res,400,{error:{code:'INVALID_REQUEST',message:'Request fields are invalid'}});return}
    if(error instanceof HubError){send(res,(error as any).httpStatus??(error as any).status??400,{error:{code:error.code,message:error.message}});return}
    send(res,500,{error:{code:'INTERNAL_ERROR',message:'Gateway could not complete this request'}});
  })});
}
