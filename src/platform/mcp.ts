import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {startMcp} from '../transport/mcp.js';
export * from '../transport/mcp.js';
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))startMcp().catch(()=>{console.error('Gateway MCP startup failed');process.exitCode=1});
