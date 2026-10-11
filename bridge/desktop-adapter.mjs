import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pipeRequest} from './desktop-pipe.mjs';
export class DesktopError extends Error {constructor(code,message){super(message);this.code=code;}}
const uuid=/^[0-9a-f-]{36}$/i;
const permitted=new Set(['read_thread','list_projects','send_message_to_thread','create_thread']);
export class DesktopAdapter {
 constructor({configPath=new URL('./desktop-context.json',import.meta.url),request=pipeRequest,listPipes=()=>readdir('\\\\.\\pipe\\')}={}){this.configPath=configPath;this.request=request;this.listPipes=listPipes;this.cachedPath=null;}
 async config(){
  let c;try{c=JSON.parse(await readFile(this.configPath,'utf8'));}catch{throw new DesktopError('DESKTOP_NOT_CONFIGURED','Desktop routing is not configured. Re-run the bridge installer from Codex desktop.');}
  if(!uuid.test(c.originThreadId)||!uuid.test(c.originTurnId)||!/^\\\\\.\\pipe\\[a-zA-Z0-9_.-]+-$/.test(c.pipePrefix))throw new DesktopError('DESKTOP_NOT_CONFIGURED','Invalid desktop routing configuration.');
  return c;
 }
 async supports(path){
  try{const r=await this.request({jsonrpc:'2.0',id:randomUUID(),method:'tools/list'},{path,timeoutMs:2000});return !r.error&&['read_thread','send_message_to_thread','create_thread','list_projects'].every(n=>r.result?.tools?.some(t=>t.namespace==='codex_app'&&t.name===n));}catch{return false;}
 }
 async prepare(){
  const c=await this.config();
  const preferred=typeof c.preferredPath==='string'&&c.preferredPath.startsWith(c.pipePrefix)&&uuid.test(c.preferredPath.slice(c.pipePrefix.length))?c.preferredPath:null;
  for(const path of [...new Set([this.cachedPath,preferred,process.env.CODEX_APP_TOOLS_PIPE_PATH].filter(Boolean))])if(path.startsWith(c.pipePrefix)&&uuid.test(path.slice(c.pipePrefix.length))&&await this.supports(path)){this.cachedPath=path;return {path,config:c};}
  // Rediscover a restarted desktop using only same-prefix local pipe endpoints,
  // then verify the published app-tool schema. Never retry a mutation here.
  let names;try{names=await this.listPipes();}catch{names=[];}
  const candidates=[...new Set(names.map(n=>n.startsWith('\\\\.\\pipe\\')?n:'\\\\.\\pipe\\'+n).filter(n=>n.startsWith(c.pipePrefix)&&uuid.test(n.slice(c.pipePrefix.length))))];
  if(candidates.length>512)throw new DesktopError('DESKTOP_UNAVAILABLE','Too many desktop endpoint candidates; reconnect the bridge from Codex.');
  const matches=[];let next=0;const worker=async()=>{for(;;){const p=candidates[next++];if(p===undefined)return;if(await this.supports(p))matches.push(p);}};
  await Promise.all(Array.from({length:Math.min(16,candidates.length)},worker));
  if(matches.length!==1)throw new DesktopError('DESKTOP_UNAVAILABLE',matches.length?'Multiple desktop instances found; reconnect the bridge from the intended instance.':'Codex desktop is unavailable. Open it and retry with the same requestId.');
  this.cachedPath=matches[0];return {path:matches[0],config:c};
 }
 async call(connection,tool,args){
  if(!permitted.has(tool))throw new DesktopError('DESKTOP_TOOL_BLOCKED','Desktop operation is not allowed by this adapter.');
  // The recorded installation origin is a Codex conversation; this is its app context, not the upstream client identity.
  let r;try{r=await this.request({jsonrpc:'2.0',id:randomUUID(),method:'tools/call',params:{callerSource:'codex',namespace:'codex_app',tool,arguments:args,threadId:connection.config.originThreadId,turnId:connection.config.originTurnId,callId:randomUUID()}},{path:connection.path,timeoutMs:45000});}
  catch(e){this.cachedPath=null;const error=new DesktopError(e.noSubmission?'DESKTOP_UNAVAILABLE':'OUTCOME_UNKNOWN',e.noSubmission?'Desktop disconnected before submission. Retry with the same requestId.':'Desktop reply was lost. Submission outcome is unknown; keep the same requestId and inspect the task.');error.noSubmission=e.noSubmission;throw error;}
  if(r.error||r.result?.success!==true)throw new DesktopError('OUTCOME_UNKNOWN','Desktop did not confirm the operation. Inspect the task before retrying.');
  const texts=r.result.contentItems?.filter(x=>x.type==='inputText').map(x=>x.text)??[];
  for(const text of texts)try{return JSON.parse(text);}catch{}
  throw new DesktopError('OUTCOME_UNKNOWN','Desktop response format changed; acceptance is unconfirmed.');
 }
 async read(connection,id){return this.call(connection,'read_thread',{threadId:id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:0});}
}
