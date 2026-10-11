import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile,rename,readdir,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,dirname} from 'node:path';
import {Receiver,Sender} from 'ws';
import {BRIDGE_CONFIG} from './bridge-config.mjs';
import {DesktopAdapter,DesktopError} from './desktop-adapter.mjs';

export const PROJECTS=BRIDGE_CONFIG.projects;
export const canonicalProject=(p,config=BRIDGE_CONFIG)=>p==='local'&&config.localAlias?config.localAlias:p;
const shellQuote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
export function normalize(p){return String(p).replace(/^\\\\\?\\/,'').replace(/\\/g,'/').replace(/\/+$/,'').replace(/^([A-Z]):/,(_,x)=>x.toLowerCase()+':');}
export class BridgeError extends Error {constructor(code,message){super(message);this.code=code;}}
const fail=(code,message)=>{throw new BridgeError(code,message);};
const bound=(n,lo,hi)=>Number.isInteger(n)&&n>=lo&&n<=hi;
const uuid=/^[0-9a-f-]{36}$/i;
export const LOCAL_CREATE_FOOTER_VERSION='v1';
export function localCreateDispatchFooter(originThreadId){
  const provenance=uuid.test(originThreadId??'')?`The desktop app's native source_thread_id may be ${originThreadId}; that is creation provenance, not your direct parent.`:'The desktop app may provide a native source_thread_id; that is creation provenance, not your direct parent.';
  return `[Bridge coordination note ${LOCAL_CREATE_FOOTER_VERSION}]\n${provenance} This independently user-owned task reports final results here. Descendants MUST report to their actual parent using native collaboration/send_message or by returning in their final response. Never use source_thread_id as a report destination, and do not send unsolicited cross-thread reports to the maintenance origin.`;
}

// One persistent protocol connection per host; no CLI exec prompts and no transcript writes.
export class Rpc {
  constructor(project,{config=BRIDGE_CONFIG,sshConfig=config.sshConfig,transport=process.env.CODEX_TASK_BRIDGE_TRANSPORT??config.transport,nativeCodex=process.env.CODEX_TASK_BRIDGE_CODEX??config.nativeCodex??'codex',spawnProcess=spawn}={}){if(!['ssh','native'].includes(transport))fail('INVALID_TRANSPORT','Task bridge transport must be ssh or native.');this.config=config;this.project=canonicalProject(project,config);if(!Object.hasOwn(config.projects,this.project))fail('INVALID_PROJECT','Configure the task project before connecting.');this.sshConfig=sshConfig;this.transport=transport;this.nativeCodex=nativeCodex;this.spawnProcess=spawnProcess;this.seq=0;this.pending=new Map();this.blocked=new Map();this.owned=new Set();this.handoffs=new Map();this.alive=false;}
  remoteArguments(){const host=this.config.projects[this.project].host;if(!host)fail('INVALID_SSH_CONFIG','Configure an SSH Host for this project.');return [...(this.sshConfig?['-F',this.sshConfig]:[]),'-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3',host,'exec '+shellQuote(this.config.remoteCodex??'codex')+' app-server proxy'];}
  async connect(){
    if(this.connecting)return this.connecting;
    if(this.alive)return;
    this.connecting=this.open();
    try{await this.connecting;}catch(e){this.close();throw e;}finally{this.connecting=null;}
  }
  async open(){
    const env={...process.env};delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
    const command=this.transport==='native'?{executable:this.nativeCodex,args:['app-server','proxy']}:{executable:this.config.sshExecutable??'ssh',args:this.remoteArguments()};
    this.child=this.spawnProcess(command.executable,command.args,{windowsHide:true,stdio:['pipe','pipe','ignore'],env,cwd:dirname(fileURLToPath(import.meta.url))});
    this.alive=true;
    this.child.on('error',()=>this.breakConnection());this.child.on('exit',()=>this.breakConnection());
    this.child.stdin.on('error',()=>this.breakConnection());
    await this.websocket();
    await this.request('initialize',{clientInfo:{name:'codex_chatgpt_tasks',title:'ChatGPT task bridge',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.send({method:'initialized'});
  }
  async websocket(){
    const child=this.child,key=randomBytes(16).toString('base64');
    const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const sender=new Sender(child.stdin),receiver=new Receiver({isServer:false,maxPayload:128*1024*1024});
    this.send=x=>sender.send(JSON.stringify(x),{mask:true,fin:true,binary:false,compress:false},e=>{if(e)this.breakConnection();});
    receiver.on('message',raw=>{try{this.handle(JSON.parse(raw));}catch{this.breakConnection();}});
    receiver.on('ping',data=>sender.pong(data,true,()=>{}));
    receiver.on('error',()=>this.breakConnection());receiver.on('conclude',()=>this.breakConnection());
    await new Promise((resolve,reject)=>{
      let header=Buffer.alloc(0),ready=false;
      const timer=setTimeout(()=>reject(new BridgeError('CONNECT_TIMEOUT','Remote control handshake timed out.')),20000);
      child.stdout.on('data',chunk=>{
        if(ready){receiver.write(chunk);return;}
        header=Buffer.concat([header,chunk]);const end=header.indexOf('\r\n\r\n');
        if(end<0){if(header.length>16384){clearTimeout(timer);reject(new BridgeError('PROTOCOL_ERROR','Invalid WebSocket header.'));}return;}
        const text=header.subarray(0,end).toString();
        if(!text.startsWith('HTTP/1.1 101 ')||!text.toLowerCase().includes('sec-websocket-accept: '+accept.toLowerCase())){clearTimeout(timer);reject(new BridgeError('PROTOCOL_ERROR','WebSocket handshake rejected.'));return;}
        ready=true;clearTimeout(timer);resolve();receiver.write(header.subarray(end+4));header=null;
      });
      child.stdin.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
  }
  handle(msg){
    if(msg.method&&msg.id===undefined)this.onNotification?.(msg);
    if(msg.method&&msg.id!==undefined){
      // Never silently grant approvals, answer questions, or invoke dynamic tools.
      const id=msg.params?.threadId??msg.params?.conversationId;
      if(id)this.blocked.set(id,{method:msg.method,action:'not_approved',message:'Approval was not granted. Pausing the turn and releasing the bridge subscription; check handoff status before continuing in Codex.'});
      if(msg.method.endsWith('/requestApproval'))this.send({id:msg.id,result:{decision:'decline'}});
      else this.send({id:msg.id,error:{code:-32601,message:'Interactive request requires the user in Codex.'}});
      if(id)this.onLifecycle?.(id,'needs_user');
      return;
    }
    if(msg.method==='turn/completed'&&msg.params?.threadId){this.onLifecycle?.(msg.params.threadId,'turn_finished');return;}
    const pending=this.pending.get(msg.id);if(!pending)return;
    this.pending.delete(msg.id);clearTimeout(pending.timer);
    if(msg.error){
      const writerConflict=pending.method==='thread/resume'&&/active writer/i.test(msg.error.message??'');
      const error=new BridgeError(writerConflict?'TASK_OPEN_ELSEWHERE':'RPC_REJECTED',writerConflict?'This task is open for writing in another Codex client. Close that task there, then retry with the same requestId and arguments. No message was submitted.':`${pending.method} rejected by Codex (code ${msg.error.code}).`);
      error.upstreamMessage=msg.error.message;pending.reject(error);
    }
    else pending.resolve(msg.result);
  }
  request(method,params){
    if(!this.alive)return Promise.reject(new BridgeError('DISCONNECTED','Codex connection is unavailable.'));
    return new Promise((resolve,reject)=>{
      const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeError('OUTCOME_UNKNOWN',`${method} timed out. Do not submit again with a new requestId; inspect the task first.`));},45000);
      this.pending.set(id,{resolve,reject,timer,method});
      try{this.send({id,method,params});}catch{this.breakConnection();}
    });
  }
  breakConnection(){this.alive=false;this.onDisconnect?.();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('OUTCOME_UNKNOWN','Connection lost. A submitted task may still be running.'));}this.pending.clear();}
  close(){this.breakConnection();this.lines?.close();this.child?.kill();}
  async closeAndWait(){
    const child=this.child;
    if(!child||child.exitCode!==null){this.close();return;}
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new BridgeError('RELEASE_UNCONFIRMED','Codex backend has not exited; writer lock release is unconfirmed.')),10000);
      child.once('exit',()=>{clearTimeout(timer);resolve();});this.close();
    });
  }
}

export function taskMeta(t){return {threadId:t.id,title:t.name??t.preview??'',cwd:t.cwd,status:t.status,createdAt:t.createdAt,updatedAt:t.updatedAt};}
export function visibleTurns(turns,limit,maxChars){
  let remaining=maxChars,truncated=false;
  const selected=turns.slice(-limit).map(t=>({turnId:t.id,status:t.status,messages:(t.items??[]).flatMap(i=>{
    let role,text;
    if(i.type==='agentMessage'&&i.phase!=='analysis'){role='assistant';text=i.text??'';}
    else if(i.type==='userMessage'){role='user';text=(i.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');}
    else return [];
    if(!text)return [];
    const shown=text.slice(0,remaining);remaining-=shown.length;const cut=shown.length<text.length;truncated||=cut;
    return shown?[{role,text:shown,truncated:cut}]:[];
  })}));
  return {turns:selected,truncated};
}

export const REASONING_EFFORTS=Object.freeze(['low','medium','high','xhigh','max','ultra']);
export const LEGACY_MODEL_POLICY=Object.freeze({schemaVersion:1,allowedModels:null,allowedReasoningEfforts:['medium','high','xhigh'],defaultModel:'gpt-6.1-sol',defaultReasoningEffort:'xhigh'});
export function validateModelPolicy(value){
  const invalid=()=>fail('MODEL_POLICY_INVALID','Model policy is invalid. No task submitted; repair model-policy.json using the local settings utility.');
  if(!value||typeof value!=='object'||Array.isArray(value)||value.schemaVersion!==1)invalid();
  const ids=value.allowedModels,efforts=value.allowedReasoningEfforts;
  const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,100}$/.test(x);
  if(ids!==null&&(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(x=>!validId(x))))invalid();
  if(!Array.isArray(efforts)||!efforts.length||new Set(efforts).size!==efforts.length||efforts.some(e=>!REASONING_EFFORTS.includes(e)))invalid();
  if(!validId(value.defaultModel)||(ids!==null&&!ids.includes(value.defaultModel))||!efforts.includes(value.defaultReasoningEffort))invalid();
  return Object.freeze({schemaVersion:1,allowedModels:ids===null?null:Object.freeze([...ids]),allowedReasoningEfforts:Object.freeze([...efforts]),defaultModel:value.defaultModel,defaultReasoningEffort:value.defaultReasoningEffort});
}
export async function readModelPolicy(path){
  let raw;
  try{raw=await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return validateModelPolicy(LEGACY_MODEL_POLICY);fail('MODEL_POLICY_INVALID','Cannot read model policy. No task submitted.');}
  if(raw.length>1048576)fail('MODEL_POLICY_INVALID','Model policy exceeds the supported size.');
  let value;try{value=JSON.parse(raw.replace(/^\uFEFF/,''));}catch{fail('MODEL_POLICY_INVALID','Model policy JSON is malformed. No task submitted.');}
  return validateModelPolicy(value);
}

export class TaskBridge {
  constructor({config=BRIDGE_CONFIG,stateDir=process.env.CODEX_TASK_BRIDGE_STATE_DIR??join(dirname(fileURLToPath(import.meta.url)),'.state'),factory,desktop=null,policyPath=process.env.CODEX_TASK_BRIDGE_MODEL_POLICY??join(dirname(fileURLToPath(import.meta.url)),'model-policy.json'),policyReader=readModelPolicy}={}){this.config=config;this.stateDir=stateDir;this.factory=factory??(p=>new Rpc(p,{config}));this.desktop=desktop;this.policyPath=policyPath;this.policyReader=policyReader;this.clients=new Map();this.locks=new Map();}
  async policy(){return validateModelPolicy(await this.policyReader(this.policyPath));}
  project(p){p=canonicalProject(p,this.config);if(!Object.hasOwn(this.config.projects,p))fail('INVALID_PROJECT','project must name a configured project or its explicit local alias.');return this.config.projects[p];}
  async models({project},policy){
    policy??=await this.policy();
    project=canonicalProject(project,this.config);
    const c=await this.client(project),models=[];let cursor;const seen=new Set();
    do{
      const page=await c.request('model/list',{includeHidden:false,...(cursor?{cursor}:{})});
      models.push(...page.data.filter(m=>policy.allowedModels===null||policy.allowedModels.includes(m.model)).map(m=>{
        const reasoningEfforts=REASONING_EFFORTS.filter(e=>policy.allowedReasoningEfforts.includes(e)&&m.supportedReasoningEfforts.some(x=>x.reasoningEffort===e));
        return {model:m.model,description:m.description,isDefault:m.model===policy.defaultModel,reasoningEfforts,defaultReasoningEffort:reasoningEfforts.includes(policy.defaultReasoningEffort)?policy.defaultReasoningEffort:reasoningEfforts.at(-1)};
      }).filter(m=>m.reasoningEfforts.length));
      cursor=page.nextCursor;
      if(cursor&&seen.has(cursor))fail('MODEL_CATALOG_ERROR','Model catalog pagination repeated.');
      if(cursor)seen.add(cursor);
    }while(cursor);
    return {project,models,policy:{...policy,highestAlias:'highest supported effort in current allowlist'}};
  }
  async validateExecution(execution,project,policy,{persisted=false}={}){
    if(policy.allowedModels!==null&&!policy.allowedModels.includes(execution.model))fail(persisted?'MODEL_POLICY_CHANGED':'MODEL_NOT_ALLOWED','Selected model is excluded by the current model policy. No message submitted.');
    if(!policy.allowedReasoningEfforts.includes(execution.reasoningEffort))fail(persisted?'REASONING_POLICY_CHANGED':'REASONING_NOT_ALLOWED','Selected effort is excluded by the current model policy. No message submitted.');
    const catalog=await this.models({project},policy),m=catalog.models.find(m=>m.model===execution.model);
    if(!m)fail('MODEL_UNAVAILABLE','Selected model is not available on this host. Query codex_list_models.');
    if(!m.reasoningEfforts.includes(execution.reasoningEffort))fail('UNSUPPORTED_REASONING_EFFORT','Selected model does not support this effort. Query codex_list_models.');
    return execution;
  }
  async executionOptions(a,policy){
    policy??=await this.policy();
    if(a.model!==undefined&&(typeof a.model!=='string'||!a.model.trim()||a.model.length>100))fail('INVALID_MODEL','Invalid model name.');
    if(a.reasoningEffort!==undefined&&![...REASONING_EFFORTS,'highest'].includes(a.reasoningEffort))fail('INVALID_REASONING_EFFORT','Unknown reasoning effort.');
    const model=a.model??policy.defaultModel;
    let effort=a.reasoningEffort??policy.defaultReasoningEffort;
    if(effort==='highest'){
      if(policy.allowedModels!==null&&!policy.allowedModels.includes(model))fail('MODEL_NOT_ALLOWED','Selected model is excluded by the current model policy.');
      const catalog=await this.models({project:a.project},policy),m=catalog.models.find(m=>m.model===model);
      if(!m)fail('MODEL_UNAVAILABLE','Selected model is not available on this host. Query codex_list_models.');
      effort=[...REASONING_EFFORTS].reverse().find(e=>policy.allowedReasoningEfforts.includes(e)&&m.reasoningEfforts.includes(e));
    }
    return this.validateExecution({model,reasoningEffort:effort},a.project,policy);
  }
  async client(p,taskKey){this.project(p);const key=p==='local'&&taskKey?p+':'+taskKey:p;let c=this.clients.get(key);if(!c){c=this.factory(p);c.owned??=new Set();c.handoffs??=new Map();c.onLifecycle=(id,reason)=>{
    if(!c.owned.has(id))return;
    void this.locked('host:'+p,()=>this.detach(c,p,id,reason==='needs_user',reason)).catch(e=>c.handoffs.set(id,{state:'release_failed',reason,code:e.code??'INTERNAL_ERROR'}));
  };this.clients.set(key,c);}await c.connect();return c;}
  async locked(key,fn){const prior=this.locks.get(key)??Promise.resolve();const current=prior.catch(()=>{}).then(fn);this.locks.set(key,current);try{return await current;}finally{if(this.locks.get(key)===current)this.locks.delete(key);}}
  async scoped(c,p,id,includeTurns=false,turnLimit=3){
    if(!/^[0-9a-f-]{36}$/i.test(id))fail('INVALID_THREAD','Invalid task id.');
    const {thread}=await c.request('thread/read',{threadId:id,includeTurns:false});
    if(normalize(thread.cwd)!==normalize(this.project(p).cwd))fail('OUT_OF_SCOPE','Task is outside the selected project.');
    if(!includeTurns)return thread;
    const page=await c.request('thread/turns/list',{threadId:id,limit:turnLimit,sortDirection:'desc',itemsView:'full'});
    return {...thread,turns:[...page.data].reverse()};
  }
  async list({project,archived=false,limit=30,cursor}){
    project=canonicalProject(project,this.config);
    if(!bound(limit,1,100)||typeof archived!=='boolean')fail('INVALID_INPUT','Invalid list bounds.');
    const c=await this.client(project),p=this.project(project);
    const r=await c.request('thread/list',{cwd:p.cwd,archived,limit,cursor,sortKey:'updated_at',sourceKinds:[]});
    return {project,host:p.host,tasks:r.data.filter(t=>normalize(t.cwd)===normalize(p.cwd)).map(taskMeta),nextCursor:r.nextCursor??null};
  }
  async read({project,threadId,turnLimit=3,maxChars=20000}){
    project=canonicalProject(project,this.config);
    if(!bound(turnLimit,1,10)||!bound(maxChars,100,50000))fail('INVALID_INPUT','Invalid read bounds.');
    const owner=this.clients.get(project==='local'?project+':'+threadId:project);
    const c=owner?.alive?owner:await this.client(project);await c.connect();
    const t=await this.scoped(c,project,threadId,true,turnLimit),state=owner??c;
    const result={project,host:this.project(project).host,...taskMeta(t),...visibleTurns(t.turns??[],turnLimit,maxChars),blockedRequest:state.blocked.get(threadId)??null,handoff:state.handoffs.get(threadId)??{state:state.owned.has(threadId)?'bridge_owned':'not_owned_by_bridge'},observedAt:new Date().toISOString()};
    if(project==='local'&&this.desktop){
      try{const connection=await this.desktop.prepare(),live=await this.desktop.read(connection,threadId);this.checkDesktopScope(live,project,threadId);result.status=live.thread.status;result.executionOwner='desktop';result.handoff={state:'desktop_managed',bridgeHoldsWriter:false};}
      catch(e){result.desktopStatusUnavailable=e.code??'DESKTOP_UNAVAILABLE';}
    }
    return result;
  }
  async detach(c,project,threadId,interrupt=false,reason='requested'){
    if(c.handoffs.get(threadId)?.state==='released')return {project,threadId,released:true,...c.handoffs.get(threadId)};
    let t=await this.scoped(c,project,threadId,true,1);
    if(!c.owned.has(threadId))return {project,threadId,released:c.handoffs.get(threadId)?.state==='released',state:c.handoffs.get(threadId)?.state??'not_owned_by_bridge'};
    const active=()=>t.status?.type==='active'||t.turns?.at(-1)?.status==='inProgress';
    if(active()){
      if(!interrupt)fail('TASK_BUSY','Task is running. Explicitly authorize interrupt=true to stop it before releasing.');
      const turnId=t.turns?.at(-1)?.id;if(!turnId)fail('UNKNOWN_TURN','Cannot safely identify the active turn.');
      c.handoffs.set(threadId,{state:'interrupting',reason});
      await c.request('turn/interrupt',{threadId,turnId});
      const deadline=Date.now()+15000;
      do {await new Promise(r=>setTimeout(r,100));t=await this.scoped(c,project,threadId,true,1);}while(active()&&Date.now()<deadline);
      if(active())fail('INTERRUPT_PENDING','Interruption has not completed; subscription was retained.');
    }
    c.handoffs.set(threadId,{state:'releasing',reason});
    const result=await c.request('thread/unsubscribe',{threadId});
    if(!['unsubscribed','notLoaded','notSubscribed'].includes(result.status))fail('RELEASE_UNCONFIRMED','Codex did not confirm unsubscribe.');
    // Current Windows App Server can retain its writer lease after unsubscribe.
    // Each local writer therefore has its own process, closed only after idle.
    if(project==='local'){
      if(c.owned.size!==1)fail('SHARED_WRITER','Refusing to stop a backend that owns multiple tasks.');
      if(c.closeAndWait)await c.closeAndWait();else c.close();
    }
    c.owned.delete(threadId);
    const outcome={state:'released',reason,subscriptionStatus:result.status,releasedAt:new Date().toISOString()};
    c.handoffs.set(threadId,outcome);
    return {project,threadId,released:true,...outcome};
  }
  async release({project,threadId,interrupt=false}){
    project=canonicalProject(project,this.config);
    if(typeof interrupt!=='boolean')fail('INVALID_INPUT','interrupt must be boolean.');
    if(project==='local'&&this.desktop){
      const connection=await this.desktop.prepare(),live=await this.desktop.read(connection,threadId);this.checkDesktopScope(live,project,threadId);
      if(interrupt)fail('DESKTOP_MANAGED','The desktop owns execution. Stop the task in Codex desktop; the bridge holds no writer to release.');
      return {project,threadId,released:true,state:'desktop_managed',bridgeHoldsWriter:false,status:live.thread.status};
    }
    const c=this.clients.get(project==='local'?project+':'+threadId:project)??await this.client(project);
    if(c.handoffs.get(threadId)?.state==='released')return {project,threadId,released:true,...c.handoffs.get(threadId)};
    return this.locked('host:'+project,()=>this.detach(c,project,threadId,interrupt));
  }
  async journal(id,payload,fn){
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(id))fail('INVALID_REQUEST_ID','Use a unique requestId with 8-100 letters, numbers, underscores or hyphens; reuse it for retries.');
    const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.locked('request:'+id,async()=>{
      await mkdir(this.stateDir,{recursive:true});const path=join(this.stateDir,id+'.json');let existing;
      try{existing=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(existing){
        if(existing.hash!==hash){
          // An operator may authorize ONE prompt revision for a verified unsent
          // follow-up. Never relax accepted, dispatching or unscoped records.
          const allowed=existing.state==='not_sent'&&existing.allowPromptRevision===true&&existing.kind==='send'&&payload.kind==='send'&&existing.project===payload.project&&existing.threadId===payload.threadId;
          if(!allowed)fail('REQUEST_ID_CONFLICT','This requestId was used with different arguments.');
          existing={...existing,allowPromptRevision:false,priorAttempts:[...(existing.priorAttempts??[]),{hash:existing.hash,state:existing.state,lastErrorCode:existing.lastErrorCode,revisedAt:new Date().toISOString()}]};
        }
        if(existing.state==='accepted')return {...existing.result,replayed:true};
        if(!['prepared','not_sent'].includes(existing.state))fail('OUTCOME_UNKNOWN','Submission outcome is unresolved. Keep the same requestId; inspect and reconcile its recorded task before retrying.');
      }
      const write=async value=>{await writeFile(path+'.tmp',JSON.stringify(value),{encoding:'utf8',mode:0o600});await rename(path+'.tmp',path);};
      let record={...existing,hash,state:'prepared',project:payload.project,kind:payload.kind,threadId:existing?.threadId??payload.threadId,createdAt:existing?.createdAt??new Date().toISOString()};
      const checkpoint=async(state,fields={})=>{const next={...record,...fields,state,updatedAt:new Date().toISOString()};await write(next);record=next;};
      await checkpoint('prepared');
      try {
        const result=await fn(checkpoint,record);
        await checkpoint('accepted',{result});return result;
      }catch(e){
        // Only a persisted pre-dispatch stage proves that no turn was submitted.
        // Timeouts/crashes during thread creation or turn/start remain uncertain.
        if(record.state==='prepared')await checkpoint('not_sent',{lastErrorCode:e.code??'INTERNAL_ERROR'});
        throw e;
      }
    });
  }
  async mutate(kind,a){
    a={...a,project:canonicalProject(a.project,this.config)};
    const p=this.project(a.project);
    if(typeof a.prompt!=='string'||!a.prompt.trim()||a.prompt.length>50000)fail('INVALID_INPUT','prompt must contain 1-50000 characters.');
    if(kind==='create'&&(typeof a.title!=='string'||!a.title.trim()||a.title.length>150))fail('INVALID_INPUT','title must contain 1-150 characters.');
    return this.locked('host:'+a.project,()=>this.journal(a.requestId,{kind,...a},async(checkpoint,record)=>{
      if(!this.config.taskPermissions)fail('TASK_DISPATCH_DISABLED','Task create/send requires explicit operator taskPermissions configuration.');
      // Capture one policy per operation; retry keeps its execution but revalidates it.
      const policy=await this.policy();
      const execution=record.execution??await this.executionOptions(a,policy);
      if(record.execution){execution.reasoningEffort??='medium';await this.validateExecution(execution,a.project,policy,{persisted:true});}
      if(Object.keys(execution).length)await checkpoint('prepared',{execution});
      if(a.project==='local'&&this.desktop){
        if(kind==='create'&&record.threadId)fail('LEGACY_CREATE_PENDING','A prior route already created a task for this request. Inspect that task before continuing; no duplicate task was created.');
        return this.desktopMutate(kind,a,checkpoint,execution,record);
      }
      const resumeId=kind==='send'?a.threadId:record.threadId;
      const temporaryKey=resumeId??'new:'+a.requestId;
      const c=await this.client(a.project,temporaryKey);let thread,dispatchStarted=false;
      try {
      if(resumeId){
        thread=await this.scoped(c,a.project,resumeId,true);
        const last=thread.turns?.at(-1);
        if(thread.status?.type==='active'||last?.status==='inProgress')fail('TASK_BUSY','Task is running. Wait for it to finish before sending another message.');
        thread=(await c.request('thread/resume',{threadId:resumeId})).thread;
        c.owned.add(thread.id);
        if(a.project==='local'){this.clients.delete(a.project+':'+temporaryKey);this.clients.set(a.project+':'+thread.id,c);}
        if(normalize(thread.cwd)!==normalize(p.cwd))fail('OUT_OF_SCOPE','Resumed task workspace changed.');
        if(thread.status?.type==='active')fail('TASK_BUSY','Task became active. No message was sent.');
      } else {
        await checkpoint('creating');
        // Only the operator's explicit configuration grants new-task permissions.
        thread=(await c.request('thread/start',{cwd:p.cwd,...this.config.taskPermissions,ephemeral:false,...(execution.model?{model:execution.model}:{})})).thread;
        c.owned.add(thread.id);
        if(a.project==='local'){this.clients.delete(a.project+':'+temporaryKey);this.clients.set(a.project+':'+thread.id,c);}
        if(normalize(thread.cwd)!==normalize(p.cwd))fail('OUT_OF_SCOPE','Created task workspace does not match.');
        await checkpoint('prepared',{threadId:thread.id});
      }
      if(kind==='create')await c.request('thread/name/set',{threadId:thread.id,name:a.title});
      c.blocked.delete(thread.id);c.handoffs.delete(thread.id);
      let r;
      await checkpoint('dispatching',{threadId:thread.id});dispatchStarted=true;
      try{r=await c.request('turn/start',{threadId:thread.id,clientUserMessageId:a.requestId,input:[{type:'text',text:a.prompt,text_elements:[]}],...(execution.model?{model:execution.model}:{}),...(execution.reasoningEffort?{effort:execution.reasoningEffort}:{})});}
      catch(e){try{await this.detach(c,a.project,thread.id,false,'submission_error');}catch{}throw e;}
      return {accepted:true,project:a.project,host:p.host,threadId:thread.id,turnId:r.turn.id,status:r.turn.status,requestId:a.requestId,submittedExecution:execution};
      } finally {
        if(!dispatchStarted){
          if(thread&&c.owned.has(thread.id)){try{await this.detach(c,a.project,thread.id,false,'not_submitted');}catch{}}
          else if(a.project==='local'&&c.owned.size===0){if(c.closeAndWait)await c.closeAndWait();else c.close();}
        }
      }
    }));
  }
  checkDesktopScope(data,project,id){
    if(!data.thread||data.thread.id!==id||data.thread.kind!=='codex'||data.thread.hostId!=='local'||normalize(data.thread.cwd)!==normalize(this.project(project).cwd))fail('OUT_OF_SCOPE','Desktop task is outside the selected project.');
  }
  async desktopMutate(kind,a,checkpoint,execution={},record={}){
    const connection=await this.desktop.prepare();let tool,args;
    if(kind==='send'){
      if(!/^[0-9a-f-]{36}$/i.test(a.threadId))fail('INVALID_THREAD','Invalid task id.');
      const live=await this.desktop.read(connection,a.threadId);this.checkDesktopScope(live,a.project,a.threadId);
      if(live.thread.status?.type==='active'||live.turns?.some(t=>t.status==='inProgress'))fail('TASK_BUSY','Task is running. Wait for completion before sending another message.');
      tool='send_message_to_thread';args={threadId:a.threadId,hostId:'local',prompt:a.prompt};
    }else{
      const result=await this.desktop.call(connection,'list_projects',{});
      const matches=result.projects?.filter(x=>x.projectKind==='local'&&x.hostId==='local'&&normalize(x.path)===normalize(this.project(a.project).cwd))??[];
      if(matches.length!==1)fail('PROJECT_NOT_FOUND','Exactly one saved desktop project must match the authorized root.');
      tool='create_thread';
      const prompt=record.dispatchFooter?`${a.prompt}\n\n${record.dispatchFooter}`:await this.dispatchPrompt(a,connection,checkpoint);
      args={title:a.title,prompt,target:{type:'project',projectId:matches[0].projectId,environment:{type:'local'}}};
    }
    if(execution.model)args.model=execution.model;
    if(execution.reasoningEffort)args.thinking=execution.reasoningEffort;
    await checkpoint('dispatching',{transport:'desktop',threadId:a.threadId});
    let result;
    try{result=await this.desktop.call(connection,tool,args);}
    catch(e){if(e.noSubmission)await checkpoint('prepared');throw e;}
    if(!result.threadId||(kind==='send'&&result.threadId!==a.threadId))fail('OUTCOME_UNKNOWN','Desktop accepted no verifiable task ID. Inspect tasks before retrying.');
    return {accepted:true,project:a.project,host:'local',threadId:result.threadId,turnId:null,status:'submitted_to_desktop',requestId:a.requestId,executionOwner:'desktop',bridgeHoldsWriter:false,submittedExecution:execution};
  }
  async dispatchPrompt(a,connection,checkpoint){
    const footer=localCreateDispatchFooter(connection?.config?.originThreadId);
    await checkpoint('prepared',{dispatchFooter:footer});
    return `${a.prompt}\n\n${footer}`;
  }
  close(){for(const c of this.clients.values())c.close();}
}
let singleton;
// A project named local is still operator-configured native/SSH. Desktop callers
// must explicitly inject their adapter; naming a project never selects Windows.
export function registerTaskTools(server,z,bridge=singleton??=new TaskBridge()){
  const projects=Object.keys(bridge.config.projects);if(!projects.length)fail('BRIDGE_NOT_CONFIGURED','Configure operator-owned bridge-config.json before starting the integrated server.');
  const project=z.enum([...projects,...(bridge.config.localAlias?['local']:[])]).describe('An explicitly configured project; local is an operator-configured legacy alias.').default(bridge.config.localAlias??projects[0]);
  const read={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
  const write={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true};
  const add=(name,description,inputSchema,annotations,fn)=>server.registerTool(name,{description,inputSchema,annotations},async a=>{
    try{const result=await fn(a);return {content:[{type:'text',text:JSON.stringify(result)}]};}
    catch(e){return {isError:true,content:[{type:'text',text:JSON.stringify({error:e.code??'INTERNAL_ERROR',message:e instanceof BridgeError||e instanceof DesktopError?e.message:'Task bridge operation failed. Inspect the local service.'})}]};}
  });
  add('codex_list_tasks','Read-only: list existing Codex tasks in an authorized project, including archived tasks when requested. Use returned threadId with codex_read_task. Does not create a task, send a message, open a workspace, or require a cloud execution environment.',{project,archived:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(30),cursor:z.string().optional()},read,a=>bridge.list(a));
  add('codex_list_models','Query available models and reasoning efforts without starting a task. Returns the current dynamically configured model/effort allowlists and defaults. Explicit overrides must satisfy that policy.',{project},read,a=>bridge.models(a));
  add('codex_read_task','Read-only: read an existing Codex task status and visible user/assistant replies. Does not resume execution, create a task, send a message, open a workspace, or require a cloud execution environment. No reasoning or tool payloads. Poll while a task runs. If truncated, use the history readers for paged text.',{project,threadId:z.string(),turnLimit:z.number().int().min(1).max(10).default(3),maxChars:z.number().int().min(100).max(50000).default(20000)},read,a=>bridge.read(a));
  const common={project,prompt:z.string().min(1).max(50000),requestId:z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/).describe('Unique submission id. Reuse exactly this id and the same arguments on a retry; never invent a new id after a timeout.')};
  common.model=z.string().min(1).max(100).optional().describe('Model ID returned by codex_list_models. Omission uses the configured default; explicit overrides must be allowed by the current policy.');
  common.reasoningEffort=z.enum([...REASONING_EFFORTS,'highest']).optional().describe('Use an effort returned by codex_list_models. Omission uses the configured default. highest selects the highest supported effort in the current allowlist. Retry options are revalidated without applying new defaults; keep identical arguments.');
  add('codex_create_task','Create a real Codex task and submit its first prompt, only on explicit user request and explicit operator taskPermissions. Consumes Codex usage. New-task sandbox/approval settings come from that configuration. Existing tasks retain their settings on follow-up. Read back to verify completion.',{...common,title:z.string().min(1).max(150)},write,a=>bridge.mutate('create',a));
  add('codex_send_message','Send a real follow-up to an idle task in an explicitly configured project, only on explicit user request and operator taskPermissions. Consumes Codex usage. Existing task permissions are preserved. Refuses already-running or out-of-project tasks. Reuse identical requestId and arguments on retries. Acceptance is not completion.',{...common,threadId:z.string()},write,a=>bridge.mutate('send',a));
  add('codex_release_task','Release the bridge subscription for a configured project; interrupt=true requires explicit user authorization. Does not start a model or approve permissions.',{project,threadId:z.string(),interrupt:z.boolean().default(false)},write,a=>bridge.release(a));
  return bridge;
}
