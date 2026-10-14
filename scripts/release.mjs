import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const archiveName=process.argv[2]??`codex-agent-gateway-windows-${version}.zip`;
if(path.basename(archiveName)!==archiveName||!archiveName.endsWith('.zip'))throw Error('Archive name must be a zip basename');
if(!fs.existsSync(path.join(root,'dist','cli.js')))throw Error('Build the gateway before packaging');
const packaged=spawnSync(process.execPath,[path.join(root,'scripts','package.mjs')],{stdio:'inherit',windowsHide:true});
if(packaged.error||packaged.status!==0)throw Error('Extension packaging failed');
fs.mkdirSync(path.join(root,'work'),{recursive:true});
const temporary=fs.mkdtempSync(path.join(root,'work','release-'));
const staging=path.join(temporary,'codex-agent-gateway');fs.mkdirSync(staging);
const entries=['.gitignore','.github','package.json','package-lock.json','tsconfig.json','README.md','PROVENANCE.md','CHANGELOG.md','src','dist','extension','scripts','skills','test','docs','codex-trae-bridge.vsix','codex-trae-bridge.vsix.sha256'];
for(const publicationFile of ['.npmrc','README.en.md','LICENSE','NOTICE.md','CONTRIBUTING.md','SECURITY.md']){
 if(fs.existsSync(path.join(root,publicationFile)))entries.push(publicationFile);
}
const manifest=[];
function include(relative){
 const source=path.join(root,relative),stat=fs.lstatSync(source);
 if(stat.isSymbolicLink())throw Error('Release input must not contain symbolic links');
 if(stat.isDirectory()){for(const name of fs.readdirSync(source).sort())include(path.join(relative,name));return;}
 if(!stat.isFile())throw Error('Release input must be a regular file');
 const normalized=relative.split(path.sep).join('/');
 if(/(^|\/)(node_modules|data|work|\.git)(\/|$)/.test(normalized)||/(^|\/)(\.env(?:\..*)?|api-token|connection\.json|service\.lock|watch\.lock)$/.test(normalized))throw Error('Private runtime input in release');
 const bytes=fs.readFileSync(source),target=path.join(staging,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
 manifest.push({file:normalized,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
for(const entry of entries)include(entry);
fs.writeFileSync(path.join(staging,'MANIFEST.json'),JSON.stringify({version,files:manifest},null,2));
const archive=path.join(root,'..',archiveName),quote=value=>"'"+value.replaceAll("'","''")+"'";
const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; if(Test-Path -LiteralPath ${quote(archive)}){Remove-Item -LiteralPath ${quote(archive)}}; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(temporary)},${quote(archive)})`],{windowsHide:true,stdio:'inherit'});
if(result.error||result.status!==0)throw Error('Windows release packaging failed');
fs.writeFileSync(archive+'.sha256',crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')+'  '+path.basename(archive)+'\n');
console.log(archive);
