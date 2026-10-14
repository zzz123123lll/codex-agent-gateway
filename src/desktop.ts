import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { HubError } from './platform/contracts.js';

export const workspaceKey = (workspace: string) => crypto.createHash('sha256').update(fs.realpathSync(workspace).toLowerCase()).digest('hex');
export interface DesktopConnection { url: string; token: string; workspace: string; pid: number; updatedAt: string; commands: string[]; version: string; }
export interface Attempt { id: string; status: 'dispatching'|'running'|'completed'|'failed'|'cancelled'|'uncertain'; sessionId?: string; requestMessageId?: string; responseMessageId?: string; error?: string; evidence?: string; nativeStatus?: string; }
export class TraeDesktop {
  constructor(readonly directory: string, readonly executable?: string) {}
  connection(workspace: string): DesktopConnection | undefined {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(this.directory,'bridges',workspaceKey(workspace)+'.json'),'utf8')) as DesktopConnection;
      const u = new URL(c.url);
      if(u.hostname!=='127.0.0.1'||u.protocol!=='http:'||!/^\d+$/.test(u.port)||!/^[a-f0-9]{64}$/.test(c.token)||fs.realpathSync(c.workspace).toLowerCase()!==fs.realpathSync(workspace).toLowerCase()) throw Error('Invalid desktop registration');
      if(u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Invalid desktop origin');
      const age=Date.now()-Date.parse(c.updatedAt);if(!Number.isFinite(age)||age>15000||age< -5000)return undefined;
      return c;
    } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined; throw error; }
  }
  async request<T>(workspace: string, route: string, data?: unknown): Promise<T> {
    const c=this.connection(workspace); if(!c)throw new HubError('DESKTOP_OFFLINE','The dedicated TRAE project window is offline',503);
    const r=await fetch(c.url+route,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+c.token,...(data===undefined?{}:{'content-type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(8000),redirect:'error'});
    const body=await r.json() as T & {error?:string}; if(!r.ok)throw new HubError('DESKTOP_ERROR',body.error??'Desktop request failed',r.status);return body;
  }
  async ensure(workspace: string) {
    if(this.connection(workspace)) return;
    if(!this.executable||!fs.statSync(this.executable).isFile())throw new HubError('DISPATCH_NOT_SENT','Configure the actual TRAE executable and install the desktop bridge');
    // Open the business directory in its own window, without restarting existing work.
    const child=spawn(this.executable,['--new-window',workspace],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
    let launchError: Error|undefined;child.on('error',e=>{launchError=e;});
    const until=Date.now()+90000;
    while(Date.now()<until){if(launchError)throw new HubError('DISPATCH_NOT_SENT',launchError.message);if(this.connection(workspace))return;await new Promise(r=>setTimeout(r,400));}
    throw new HubError('DISPATCH_NOT_SENT','TRAE project bridge did not activate. Check project trust, login and installed extension; no task prompt was sent');
  }
}
