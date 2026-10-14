export interface NativeState { state:'idle'|'busy'|'waiting_input'; workspace?:string; reason?:string }

/** Interpret observations without treating an unfamiliar application state as stopped. */
export function nativeActivity(session:any,active:any[],id:string,workspace?:string):NativeState {
  const pending=(value:any)=>Array.isArray(value)?value.length>0:typeof value==='object'&&value!==null?Object.keys(value).length>0:Boolean(value);
  const cwd=session?.cwd??session?.workspace??workspace;
  if(['pendingInputKind','pendingPermissions','pendingQuestions','pendingElicitations'].some(key=>pending(session?.[key])))return {state:'waiting_input',workspace:cwd,reason:'Native permission or input remains pending'};
  const normalize=(value:any)=>String(value??'').replaceAll('\\','/').toLowerCase().replace(/\/$/,'');
  const listed=active.some(value=>typeof value==='string'?value===id:value?.sessionId===id||value?.id===id||(cwd&&normalize(value?.cwd??value?.workspace)===normalize(cwd)));
  if(listed||['isProcessing','stopRequested','hasActiveTeamMembers','hasActiveToolCalls'].some(key=>pending(session?.[key])))return {state:'busy',workspace:cwd};
  const status=String(session?.status??session?.state??'').toLowerCase();
  return {state:['completed','failed','cancelled','idle','stopped','pending','terminated'].includes(status)?'idle':'busy',workspace:cwd};
}

/** This function is serialized for execution inside the verified renderer, not Node. */
function installRenderer(classify:typeof nativeActivity) {
  const page=window as any;
  const revision='native-gui-owner-4';
  if(page.__codexAgentGatewayV3?.revision===revision&&page.__codexAgentGatewayV3?.connected?.())return page.__codexAgentGatewayV3;
  page.__codexAgentGatewayV3?.close?.();
  const channel=new MessageChannel();
  const generation=crypto.randomUUID();
  let sequence=0,opened=false,disconnected=false;
  const pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const receipts=new Set<string>(),workspaces=new Map<string,string>();
  let readyResolve!:()=>void,readyReject!:(error:Error)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject});
  const openTimer=setTimeout(()=>{disconnected=true;readyReject(new Error('Native transport did not open'))},5000);
  function receiptFrom(event:any) {
    const sid=event?.result?.sessionId??String(event?.channel??'').replace(/^session:event:/,'');
    if(!sid||event?.channel!=='session:event:'+sid)return;
    const payload=event?.result??event;
    const metadata=payload?._meta?.['codebuddy.ai']??payload?.update?._meta?.['codebuddy.ai'];
    for(const key of ['requestId','userMessageId','messageRequestId'])if(typeof metadata?.[key]==='string')receipts.add(sid+'\n'+metadata[key]);
    if(payload?.update?.sessionUpdate==='user_message_chunk') {
      const content=payload.update.content;
      const text=typeof content==='string'?content:Array.isArray(content)?content.map(x=>x?.text??'').join(''):content?.text??'';
      for(const match of String(text).matchAll(/\[CODEX_QUEUE_WAKE ([^\]\s]+)\]/g))receipts.add(sid+'\n'+match[1]);
    }
  }
  channel.port1.onmessage=(message:any)=>{
    const frame=message.data;
    if(frame?.kind==='open'){opened=true;clearTimeout(openTimer);readyResolve();return}
    if(['close','closed','error'].includes(frame?.kind)) {
      disconnected=true;clearTimeout(openTimer);readyReject(new Error('Native transport disconnected'));
      for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(new Error('Native transport disconnected'))}pending.clear();return;
    }
    if(frame?.kind!=='message')return;
    let envelope:any;try{envelope=typeof frame.json==='string'?JSON.parse(frame.json):frame.json}catch{return}
    if(envelope?.type==='event'){receiptFrom(envelope);return}
    // WorkBuddy 5.7.7 observed frames use response; older protocol fixtures used result.
    if(!['response','result','error'].includes(envelope?.type))return;
    const operation=pending.get(String(envelope?.id));if(!operation)return;
    pending.delete(String(envelope.id));clearTimeout(operation.timer);
    if(envelope.type==='error'||envelope.error!==undefined&&envelope.error!==null)operation.reject(new Error(envelope.error?.message??'Native request failed'));else operation.resolve(envelope.result);
  };
  channel.port1.start();
  page.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[channel.port2]);
  async function request(name:string,args:any[],timeout=15000) {
    await ready;if(!opened||disconnected)throw new Error('Native transport unavailable');
    const id='agent-v3-'+generation+'-'+(++sequence);
    return new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native request timed out: '+name))},timeout);
      pending.set(id,{resolve,reject,timer});
      try{channel.port1.postMessage({kind:'message',json:JSON.stringify({id,type:'request',channel:name,args})})}catch(error){pending.delete(id);clearTimeout(timer);reject(error)}
    });
  }
  // Current desktop conversations own execution and human input independently of legacy sessions.
  const hasGuiApi=typeof page.__wbInvoke==='function';
  async function gui(method:string,...args:any[]) {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const value=await Promise.race([page.__wbInvoke('wb:conversations:'+method,undefined,...args),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native GUI request timed out: '+method)),15000)})]);
      if(value?.__wbError||value?.errorCode)throw new Error(value.message??value.errorMessage??'Native GUI request failed');
      return value;
    }finally{if(timer)clearTimeout(timer)}
  }
  function textOf(blocks:any):string {
    return typeof blocks==='string'?blocks:Array.isArray(blocks)?blocks.map(x=>x?.text??'').join(''):blocks?.text??'';
  }
  const normalize=(value:string)=>value.replaceAll('\\','/').toLowerCase().replace(/\/$/,'');
  const unwrapSession=(response:any)=>response&&Object.prototype.hasOwnProperty.call(response,'session')?response.session:response;
  function verifiedGui(conversation:any,sessionId:string,legacy:any,expectedWorkspace=workspaces.get(sessionId)) {
    const info=conversation?.info;
    if(info?.id!==sessionId)throw new Error('Native GUI session identity mismatch');
    if(info.transport!=='local')throw new Error('Native GUI transport must be local');
    const cwd=info.space?.cwd;
    if(typeof cwd!=='string'||!cwd.trim()||expectedWorkspace&&normalize(cwd)!==normalize(expectedWorkspace))throw new Error('Native GUI workspace identity mismatch');
    if(legacy!==undefined&&legacy!==null){
      if(typeof legacy!=='object'||Array.isArray(legacy)||(legacy.sessionId??legacy.id)!==sessionId)throw new Error('Native legacy inspection identity is malformed or mismatched');
      const previousCwd=legacy.cwd??legacy.workspace;
      if(typeof previousCwd!=='string'||normalize(cwd)!==normalize(previousCwd))throw new Error('Native legacy workspace identity mismatch');
    }
    return {info,cwd};
  }
  const bridge={
    revision,
    connected(){return !disconnected},
    async create(cwd:string,sessionId:string){
      if(hasGuiApi){
        const response=await gui('create',{cwd,conversationId:sessionId,transport:'local',isPlayground:false});
        verifiedGui(response,sessionId,undefined,cwd);
        workspaces.set(sessionId,cwd);return sessionId;
      }
      await request('workspace:initialize',[{cwd}]);
      const response=await request('session:create',[{cwd,sessionId,isPlayground:false}]);
      const actual=response?.sessionId??response?.session?.sessionId??sessionId;
      if(actual!==sessionId)throw new Error('Native session identity mismatch');
      workspaces.set(actual,cwd);return actual;
    },
    async inspect(sessionId:string){
      const [response,active]=await Promise.all([request('session:get',[sessionId]),request('daemon:getActiveSessions',[])]);
      const session=unwrapSession(response);
      if(typeof session?.sessionId==='string'&&session.sessionId!==sessionId)throw new Error('Native inspection session identity mismatch');
      if(!hasGuiApi&&typeof (session?.cwd??session?.workspace)==='string')workspaces.set(sessionId,session.cwd??session.workspace);
      const list=Array.isArray(active)?active:active?.sessions;
      if(!Array.isArray(list))throw new Error('Native active session inspection is malformed');
      const legacy=classify(session,list,sessionId,workspaces.get(sessionId));
      if(!hasGuiApi)return legacy;
      const [conversation,input,queued]=await Promise.all([gui('get',sessionId),gui('getPendingInfo',sessionId),gui('queueItems',sessionId)]);
      const {info,cwd}=verifiedGui(conversation,sessionId,session);
      // Explicit absence from the old manager is expected for a GUI-created conversation.
      // Transport errors or malformed legacy objects are never treated as that absence.
      const previous=session===undefined||session===null?classify({status:'idle',cwd},list,sessionId,cwd):legacy;
      workspaces.set(sessionId,cwd);
      if(previous.state!=='idle')return previous;
      if(input!==undefined&&input!==null)return {state:'waiting_input',workspace:cwd,reason:'Native GUI permission or input remains pending'};
      if(!Array.isArray(queued))throw new Error('Native GUI queue inspection is malformed');
      if(queued.length||info.hasActiveChildAgents||info.hasRunningBackgroundTasks)return {state:'busy',workspace:cwd};
      return {state:['idle','terminated','failed'].includes(info.state)?'idle':'busy',workspace:cwd};
    },
    async receipt(sessionId:string,wakeId:string){
      if(receipts.has(sessionId+'\n'+wakeId))return true;
      if(hasGuiApi){
        const inputs=await gui('inputHistory',sessionId);
        if(!Array.isArray(inputs))throw new Error('Native GUI input history is malformed');
        const marker='[CODEX_QUEUE_WAKE '+wakeId+']';
        const found=inputs.some(value=>textOf(value?.blocks).startsWith(marker+'\n'));
        if(found)receipts.add(sessionId+'\n'+wakeId);
        return found;
      }
      await request('session:load',[sessionId,{cwd:workspaces.get(sessionId),forceRendererHistoryReplay:true}]);
      return receipts.has(sessionId+'\n'+wakeId);
    },
    async send(sessionId:string,wakeId:string,prompt:string){
      if(hasGuiApi){
        if((await bridge.inspect(sessionId)).state!=='idle')throw new Error('Native owners are not confirmed idle; dispatch refused');
        await gui('sendPrompt',sessionId,[{type:'text',text:prompt}],{clientRequestId:wakeId});
        if(!await bridge.receipt(sessionId,wakeId))throw new Error('Native GUI dispatch acknowledgement missing; reconcile without sending again');
        return;
      }
      let failure:unknown;
      // A send response can represent the complete inference. Only a matching user receipt acknowledges dispatch.
      void request('session:sendMessage',[sessionId,[{type:'text',text:prompt}],{'codebuddy.ai':{requestId:wakeId,userMessageId:wakeId,messageRequestId:wakeId,emitSyntheticUserPromptLive:true}}],30000).catch(error=>{failure=error});
      const deadline=Date.now()+8000;
      while(Date.now()<deadline){if(failure)throw failure;if(receipts.has(sessionId+'\n'+wakeId))return;await new Promise(resolve=>setTimeout(resolve,20))}
      throw new Error('Dispatch acknowledgement missing; reconcile without sending again');
    },
    async cancel(sessionId:string){
      if(!hasGuiApi){await request('session:cancel',[sessionId]);return}
      const [response,conversation]=await Promise.all([request('session:get',[sessionId]),gui('get',sessionId)]);
      const legacy=unwrapSession(response),{cwd}=verifiedGui(conversation,sessionId,legacy);
      if((legacy===undefined||legacy===null)&&!workspaces.has(sessionId))throw new Error('Native cancellation workspace binding is unconfirmed; inspect the session first');
      workspaces.set(sessionId,cwd);
      const failures:string[]=[];
      if(legacy!==undefined&&legacy!==null){
        try{await request('session:cancel',[sessionId])}catch(error){failures.push('Legacy owner: '+(error instanceof Error?error.message:String(error)))}
      }
      try{await gui('cancel',sessionId)}catch(error){failures.push('GUI owner: '+(error instanceof Error?error.message:String(error)))}
      if(failures.length)throw new Error('Native cancellation incomplete: '+failures.join('; '));
    },
    close(){disconnected=true;channel.port1.close();clearTimeout(openTimer);for(const operation of pending.values()){clearTimeout(operation.timer);operation.reject(new Error('Native bridge closed'))}pending.clear()}
  };
  page.__codexAgentGatewayV3=bridge;return bridge;
}

export const WORKBUDDY_BRIDGE='('+installRenderer.toString()+')('+nativeActivity.toString()+')';
