import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {listenerOwner} from './actor.js';
import {WORKBUDDY_BRIDGE,type NativeState} from './bridge.js';

export interface WorkBuddyDriver {
  owner():Promise<number>;create(workspace:string,sessionId:string):Promise<void|string>;
  inspect(sessionId:string):Promise<NativeState>;receipt(sessionId:string,wakeId:string):Promise<boolean>;
  send(sessionId:string,wakeId:string,prompt:string):Promise<void|boolean>;cancel(sessionId:string):Promise<void>;close():void|Promise<void>;
}

/** CDP is only a verified renderer transport; the application performs all native work. */
class RendererConnection {
  private serial=0;
  private operations=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(private socket:WebSocket){
    socket.addEventListener('message',event=>{
      let envelope:any;try{envelope=JSON.parse(String(event.data))}catch{return}
      const operation=this.operations.get(envelope.id);if(!operation)return;
      this.operations.delete(envelope.id);clearTimeout(operation.timer);
      if(envelope.error)operation.reject(new Error('Renderer request failed'));else operation.resolve(envelope.result);
    });
    const fail=()=>{for(const operation of this.operations.values()){clearTimeout(operation.timer);operation.reject(new Error('Renderer disconnected'))}this.operations.clear()};
    socket.addEventListener('close',fail);socket.addEventListener('error',fail);
  }
  static async open(url:string){
    const socket=new WebSocket(url);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.close();reject(new Error('Renderer connection timed out'))},5000);
      socket.addEventListener('open',()=>{clearTimeout(timer);resolve()},{once:true});
      socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Renderer connection failed'))},{once:true});
    });return new RendererConnection(socket);
  }
  request(method:string,params:any,timeout=20000):Promise<any>{
    if(this.socket.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Renderer unavailable'));
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.operations.delete(id);reject(new Error('Renderer request timed out'))},timeout);
      this.operations.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}))}catch(error){this.operations.delete(id);clearTimeout(timer);reject(error)}
    });
  }
  async evaluate(expression:string){
    const result=await this.request('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??'Renderer evaluation failed');
    return result.result?.value;
  }
  close(){this.socket.close()}
}

export class WindowsWorkBuddyDriver implements WorkBuddyDriver {
  private connection?:RendererConnection;
  constructor(readonly executable:string,readonly port=18491){}
  async owner(){return listenerOwner(this.executable,this.port)}
  private async renderer(){
    await this.owner();
    if(this.connection)return this.connection;
    const response=await fetch('http://127.0.0.1:'+this.port+'/json/list',{signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new Error('Native renderer discovery failed');
    const targets=await response.json() as any[];
    const expected=path.resolve(path.dirname(this.executable),'resources','app.asar','renderer','index.html').toLowerCase();
    const candidates=targets.filter(target=>{
      if(target.type!=='page')return false;
      try{const page=new URL(target.url);return page.protocol==='file:'&&!page.host&&path.resolve(fileURLToPath(page)).toLowerCase()===expected}catch{return false}
    });
    if(candidates.length!==1)throw new Error('A unique installed native renderer was not found');
    const endpoint=new URL(candidates[0].webSocketDebuggerUrl);
    if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||Number(endpoint.port)!==this.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!endpoint.pathname.startsWith('/devtools/page/'))throw new Error('Invalid renderer debugger endpoint');
    const connected=await RendererConnection.open(endpoint.href);
    try{await connected.evaluate(WORKBUDDY_BRIDGE);this.connection=connected;return connected}catch(error){connected.close();throw error}
  }
  private async invoke<T>(method:string,args:any[]):Promise<T>{
    const renderer=await this.renderer();
    try{return await renderer.evaluate('window.__codexAgentGatewayV3.'+method+'(...'+JSON.stringify(args)+')')}
    catch(error){renderer.close();this.connection=undefined;throw error}
  }
  async create(workspace:string,sessionId:string){return this.invoke<string>('create',[workspace,sessionId])}
  async inspect(sessionId:string){return this.invoke<NativeState>('inspect',[sessionId])}
  async receipt(sessionId:string,wakeId:string){return this.invoke<boolean>('receipt',[sessionId,wakeId])}
  async send(sessionId:string,wakeId:string,prompt:string){await this.invoke('send',[sessionId,wakeId,prompt])}
  async cancel(sessionId:string){await this.invoke('cancel',[sessionId])}
  async close(){this.connection?.close();this.connection=undefined}
}
