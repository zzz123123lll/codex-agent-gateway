import fs from 'node:fs';
import {AgentHubClient} from './platform/client.js';
import {packageVersion,stateDirectory} from './runtime/settings.js';

const print=(value:unknown)=>console.log(JSON.stringify(value,null,2));
function jsonArgument(value:string|undefined){if(!value)throw Error('A JSON argument or @file is required');return JSON.parse(value.startsWith('@')?fs.readFileSync(value.slice(1),'utf8'):value);}
async function command(){
 const [name='help',...args]=process.argv.slice(2),directory=stateDirectory();
 if(name==='version'||name==='--version'){console.log(packageVersion);return;}
 if(name==='help'||name==='--help'){console.log('Codex Agent Gateway '+packageVersion+'\nCommands: serve, status, providers, submit <JSON|@file>, get <id>, list, events <id> [after], wait <id> [seconds], cancel <id>, rework <id> <feedback>, accept <id> <JSON|@file>, recover <id> <reason>, version');return;}
 if(name==='serve'){
  const {startRuntime}=await import('./runtime/lifecycle.js'),controller=new AbortController();let runtime:Awaited<ReturnType<typeof startRuntime>>|undefined;
  const stop=()=>{controller.abort();if(runtime)void runtime.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{runtime=await startRuntime(directory,controller.signal);console.error('Local gateway ready at '+runtime.url);if(controller.signal.aborted)await runtime.close();}catch(error){process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);throw error;}return;
 }
 const client=AgentHubClient.local(directory),id=args[0];
 const requiredId=()=>{if(!id)throw Error('Task id is required');return encodeURIComponent(id);};
 switch(name){
  case 'status':print(await client.request('/v1/health'));break;
  case 'providers':print(await client.request('/v1/providers'));break;
  case 'submit':print(await client.submit(jsonArgument(id)));break;
  case 'get':requiredId();print(await client.get(id!));break;
  case 'list':print(await client.request('/v1/runs'));break;
  case 'events':requiredId();print(await client.events(id!,Number(args[1]??0)));break;
  case 'wait':requiredId();print(await client.wait(id!,{timeoutMs:Number(args[1]??45)*1000}));break;
  case 'cancel':requiredId();print(await client.cancel(id!));break;
  case 'rework':requiredId();if(!args.slice(1).join(' ').trim())throw Error('Feedback is required');print(await client.rework(id!,args.slice(1).join(' ')));break;
  case 'accept':{requiredId();const input=jsonArgument(args[1]);print(await client.accept(id!,input.note,input.evidence));break;}
  case 'recover':requiredId();print(await client.request('/v1/runs/'+requiredId()+'/recover','POST',{reason:args.slice(1).join(' ')}));break;
  default:throw Error('Unknown command; use help');
 }
}
await command().catch(error=>{console.error(error instanceof Error?error.message:'Gateway command failed');process.exitCode=1;});
