import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import {AgentHubClient} from './client.js';
import {HubError,requestSchema} from '../platform/contracts.js';
import {packageVersion} from '../runtime/settings.js';

const id=z.string().min(1).max(200),text=z.string().trim().min(1).max(100000);
const validators={
  agent_hub_providers:z.object({}).strict(),
  agent_hub_submit:requestSchema,
  agent_hub_get:z.object({id}).strict(),
  agent_hub_list:z.object({limit:z.number().int().min(1).max(100).default(100),offset:z.number().int().nonnegative().safe().default(0)}).strict(),
  agent_hub_wait:z.object({id,timeoutSeconds:z.number().positive().max(50).default(45)}).strict(),
  agent_hub_events:z.object({id,after:z.number().int().nonnegative().safe().default(0)}).strict(),
  agent_hub_cancel:z.object({id}).strict(),
  agent_hub_rework:z.object({id,feedback:text}).strict(),
  agent_hub_accept:z.object({id,note:text,evidence:z.array(text).min(1).max(100)}).strict(),
  agent_hub_recover:z.object({id,reason:text}).strict(),
};
const identity={type:'string',minLength:1,maxLength:200};
const message={type:'string',minLength:1,maxLength:100000};
const tools=[
  ['providers','Describe registered native execution providers',{},[]],
  ['submit','Submit an idempotent task for native execution',{provider:{type:'string',default:'trae'},task:message,workspace:{type:'string'},output:{type:'string',enum:['text','json','artifacts'],default:'text'},idempotencyKey:identity,constraints:{type:'array',items:{type:'string'},maxItems:100},timeoutSeconds:{type:'integer',minimum:10,maximum:86400,default:1800}},['task']],
  ['get','Read task identity, state, output and independent review',{id:identity},['id']],
  ['list','List tasks with bounded pagination',{limit:{type:'integer',minimum:1,maximum:100,default:100},offset:{type:'integer',minimum:0,default:0}},[]],
  ['wait','Observe progress for at most 50 seconds without cancelling work',{id:identity,timeoutSeconds:{type:'number',exclusiveMinimum:0,maximum:50,default:45}},['id']],
  ['events','Read incremental persistent audit events',{id:identity,after:{type:'integer',minimum:0,default:0}},['id']],
  ['cancel','Request native cancellation; only confirmed native stop releases capacity',{id:identity},['id']],
  ['rework','Return concrete correction instructions to the original native session',{id:identity,feedback:message},['id','feedback']],
  ['accept','Record independent evidence after verifying this round and artifacts',{id:identity,note:message,evidence:{type:'array',items:message,minItems:1,maxItems:100}},['id','note','evidence']],
  ['recover','Reconcile an uncertain held task after native idle is independently confirmed',{id:identity,reason:message},['id','reason']],
].map(([name,description,properties,required])=>({name:'agent_hub_'+name,description:description as string,inputSchema:{type:'object' as const,properties:properties as Record<string,unknown>,required:required as string[],additionalProperties:false}}));

export function createMcpServer(client:AgentHubClient):Server{
  const server=new Server({name:'codex-agent-gateway',version:packageVersion},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    try{
      const name=request.params.name;
      if(!Object.hasOwn(validators,name))throw new HubError('UNKNOWN_TOOL','Unknown gateway tool',404);
      const args:any=validators[name as keyof typeof validators].parse(request.params.arguments||{});let result:unknown;
      const route='/v1/runs/'+encodeURIComponent(args.id||'');
      switch(name){
        case 'agent_hub_providers':result=await client.request('/v1/providers');break;
        case 'agent_hub_submit':result=await client.submit(args);break;
        case 'agent_hub_get':result=await client.get(args.id);break;
        case 'agent_hub_list':result=await client.request('/v1/runs?limit='+args.limit+'&offset='+args.offset);break;
        case 'agent_hub_wait':result=await client.request(route+'/wait?timeoutSeconds='+args.timeoutSeconds);break;
        case 'agent_hub_events':result=await client.events(args.id,args.after);break;
        case 'agent_hub_cancel':result=await client.cancel(args.id);break;
        case 'agent_hub_rework':result=await client.rework(args.id,args.feedback);break;
        case 'agent_hub_accept':result=await client.accept(args.id,args.note,args.evidence);break;
        case 'agent_hub_recover':result=await client.recover(args.id,args.reason);break;
      }
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    }catch(error){
      const detail=error instanceof z.ZodError?{code:'INVALID_REQUEST',message:'Tool arguments are invalid'}:error instanceof HubError?{code:error.code,message:error.message}:{code:'GATEWAY_ERROR',message:'Gateway tool could not complete this request'};
      return {content:[{type:'text' as const,text:JSON.stringify({error:detail})}],isError:true};
    }
  });
  return server;
}
export async function startMcp(directory?:string){const server=createMcpServer(AgentHubClient.local(directory));await server.connect(new StdioServerTransport());return server}
