import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Pass the independently installed DevSpace 1.0.8 package.json. Reuse its SDK;
// no runtime copy, HTTP listener, OAuth client, real Codex process or prompt.
if(!process.argv[2])throw Error('Usage: node integration/smoke.mjs /path/to/@waishnav/devspace/package.json');
const installed=createRequire(resolve(process.argv[2]));
assert.equal(installed('./package.json').version,'1.0.8');
const sdk=async name=>import(pathToFileURL(installed.resolve('@modelcontextprotocol/sdk/'+name)).href);
const {McpServer}=await sdk('server/mcp.js');const {Client}=await sdk('client/index.js');
const {InMemoryTransport}=await sdk('inMemory.js');const {z}=installed('zod');
const fixture=await mkdtemp(join(tmpdir(),'codex-bridge-integration-'));
let client,server,extension;
try {
  const configFile=join(fixture,'bridge-config.json');
  await writeFile(configFile,JSON.stringify({projects:{primary:{cwd:'/srv/projects/demo'}},localAlias:'primary',transport:'native'}));
  process.env.CODEX_TASK_BRIDGE_CONFIG=configFile;
  process.env.CODEX_TASK_BRIDGE_MODEL_POLICY=join(fixture,'missing-policy.json');
  extension=await import('../bridge/server-extension.mjs');
  server=new McpServer({name:'codex-bridge-integration-fixture',version:'1.0.0'});
  const tasks=extension.attachBridge(server,z);
  const id='00000000-0000-0000-0000-000000000001';const requests=[];
  const thread={id,cwd:'/srv/projects/demo',name:'Read-only fixture',status:{type:'idle'}};
  tasks.factory=()=>({owned:new Set(),blocked:new Map(),handoffs:new Map(),connect:async()=>{},close(){},request:async(method,params)=>{
    requests.push({method,params});
    if(method==='thread/list')return {data:[thread,{...thread,cwd:'/srv/outside'}],nextCursor:null};
    if(method==='thread/read')return {thread:params.threadId===id?thread:{...thread,id:params.threadId,cwd:'/srv/outside'}};
    if(method==='thread/turns/list')return {data:[{id:'fixture-turn',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'read-only fixture reply'}]}]};
    if(method==='model/list')return {data:[{model:'gpt-6.1-sol',description:'fixture',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}],nextCursor:null};
    throw Error('Unexpected non-read-only RPC: '+method);
  }});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);client=new Client({name:'bridge-smoke',version:'1.0.0'});await client.connect(clientTransport);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,6);
  for(const name of ['codex_list_tasks','codex_list_models','codex_read_task','codex_create_task','codex_send_message','codex_release_task'])assert(tools.some(tool=>tool.name===name),name+' registered');
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  assert.equal((await call('codex_list_tasks',{project:'local'})).tasks.length,1);
  assert((await call('codex_read_task',{project:'primary',threadId:id})).turns[0].messages[0].text.includes('read-only fixture reply'));
  assert.equal((await call('codex_list_models',{project:'primary'})).models.length,1);
  const outside=await client.callTool({name:'codex_read_task',arguments:{project:'primary',threadId:'00000000-0000-0000-0000-000000000002'}});
  assert.equal(outside.isError,true);assert.equal(JSON.parse(outside.content[0].text).error,'OUT_OF_SCOPE');
  assert(requests.every(r=>['thread/list','thread/read','thread/turns/list','model/list'].includes(r.method)));
  console.log(JSON.stringify({devspaceVersion:'1.0.8',taskTools:6,actualSdkProtocol:true,readOnlyCalls:3,outOfScopeDenied:true,networkListener:false,oauthClientCreated:false,modelTaskSubmitted:false}));
} finally {
  await client?.close();await server?.close();extension?.closeBridge();
  await rm(fixture,{recursive:true,force:true});
}
