import {randomBytes} from 'node:crypto';
import {posix} from 'node:path';
import {Rpc, BridgeError} from './task-bridge.mjs';
import {BRIDGE_CONFIG} from './bridge-config.mjs';

const tools = new Set(['open_workspace','read','write','edit','ls','grep','glob','bash','exec_command','write_stdin','apply_patch','show_changes','download_artifact']);
const fail = (code,message) => {throw new BridgeError(code,message);};
const text = result => ({content:[{type:'text',text:result}],structuredContent:{result}});
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const inside = (path,root) => path === root || path.startsWith(root + '/');

// File and process RPCs reuse the GPU's existing Codex daemon. No task is resumed.
export class RemoteWorkspaceBridge {
  constructor(config,{bridgeConfig=BRIDGE_CONFIG,rpc}={}) {
    const expected = bridgeConfig.projects[config.project];
    if (!expected || config.root !== expected.cwd) fail('INVALID_REMOTE_CONFIG','Remote workspace must match an operator-configured project root.');
    rpc??=new Rpc(config.project,{config:bridgeConfig});
    this.host=expected.host;this.root=config.root;this.rpc=rpc;this.workspaces=new Map();this.sessions=new Map();this.nextSession=1;
    this.rpc.onNotification=msg=>this.notification(msg);
    this.rpc.onDisconnect=()=>{for(const session of this.sessions.values())if(session.running){session.running=false;session.error='Remote command connection was lost; completion is unconfirmed.';}};
  }
  async request(method,params) {await this.rpc.connect();return this.rpc.request(method,params);}
  path(input,root=this.root) {
    if (typeof input !== 'string' || input.includes('\\') || input.includes('\0')) fail('OUT_OF_SCOPE','Only paths inside the configured remote workspace are allowed.');
    if(this.host&&input.startsWith(this.host+':'))input=input.slice(this.host.length+1);
    if(/^[A-Za-z]:/.test(input)||input.startsWith('~'))fail('OUT_OF_SCOPE','Windows and home-directory paths are outside the remote workspace.');
    const path=posix.resolve(root,input);
    if(!inside(path,root)||!inside(path,this.root))fail('OUT_OF_SCOPE','Path is outside the remote workspace.');
    return path;
  }
  async checkedPath(input,root=this.root,{missing=false}={}) {
    const path=this.path(input,root);
    const result=await this.request('command/exec',{command:['realpath',missing?'-m':'-e','--',path],cwd:this.root,timeoutMs:10000,outputBytesCap:8192});
    if(result.exitCode!==0)fail('PATH_UNAVAILABLE','Remote path is unavailable.');
    const canonical=result.stdout.trim();
    if(!inside(canonical,root)||!inside(canonical,this.root))fail('OUT_OF_SCOPE','Remote symlink resolves outside the workspace.');
    return canonical;
  }
  workspace(id) {const ws=this.workspaces.get(id);if(!ws)fail('UNKNOWN_WORKSPACE','Open the configured remote workspace again.');return ws;}
  async read(path,offset=1,limit=2000) {
    const data=Buffer.from((await this.request('fs/readFile',{path})).dataBase64,'base64');
    if(data.includes(0))fail('BINARY_FILE','This file is binary; use an appropriate remote command to inspect it.');
    const lines=data.toString('utf8').split(/\r?\n/),start=offset-1;
    const selected=lines.slice(start,start+limit).map((line,i)=>`${start+i+1}: ${line}`).join('\n');
    return selected.slice(0,65536)+(selected.length>65536?'\n[Output truncated]':'');
  }
  async open(input) {
    if(input.mode==='worktree')fail('UNSUPPORTED_MODE','The remote project uses its existing checkout; worktree creation is unavailable through this bridge.');
    const root=await this.checkedPath(input.path);
    const meta=await this.request('fs/getMetadata',{path:root});
    if(!meta.isDirectory)fail('INVALID_WORKSPACE','Remote workspace root must be a directory.');
    let workspace=[...this.workspaces.values()].find(ws=>ws.root===root);
    const reused=Boolean(workspace);
    if(!workspace){workspace={id:'gpu_'+randomBytes(8).toString('hex'),root};this.workspaces.set(workspace.id,workspace);}
    const entries=(await this.request('fs/readDirectory',{path:root})).entries;
    const agentsFiles=[];
    for(const name of ['AGENTS.md','CLAUDE.md'])if(entries.some(entry=>entry.fileName===name)){
      const path=await this.checkedPath(name,root);agentsFiles.push({path:name,content:await this.read(path,1,10000)});
    }
    const instruction='Use this workspaceId for '+root+'. File and command operations run through the configured Codex transport. Follow the returned project instructions and read nested AGENTS.md/CLAUDE.md before working there. Task project mappings and file roots are separate scopes.';
    const result={workspaceId:workspace.id,root,mode:'checkout',agentsFiles,availableAgentsFiles:[],skills:[],agentProviders:[],agents:[],skillDiagnostics:[],instruction};
    return {content:[{type:'text',text:`${reused?'Reused':'Opened'} remote workspace ${workspace.id}\nRoot: ${root}\n${instruction}`}],structuredContent:result};
  }
  async edit(path,edits) {
    let value=Buffer.from((await this.request('fs/readFile',{path})).dataBase64,'base64').toString('utf8');
    const ranges=edits.map(edit=>{
      if(!edit.oldText)fail('INVALID_EDIT','oldText must be nonempty.');
      const start=value.indexOf(edit.oldText);
      if(start<0||value.indexOf(edit.oldText,start+1)>=0)fail('INVALID_EDIT','Each oldText must match exactly once.');
      return {start,end:start+edit.oldText.length,newText:edit.newText};
    }).sort((a,b)=>a.start-b.start);
    for(let i=1;i<ranges.length;i++)if(ranges[i].start<ranges[i-1].end)fail('INVALID_EDIT','Edit ranges overlap.');
    for(const edit of ranges.reverse())value=value.slice(0,edit.start)+edit.newText+value.slice(edit.end);
    await this.request('fs/writeFile',{path,dataBase64:Buffer.from(value).toString('base64')});
    return text(`Edited ${path}`);
  }
  notification(msg) {
    const p=msg.params,session=this.sessions.get(p?.processHandle);if(!session)return;
    if(msg.method==='process/outputDelta') {session.output+=Buffer.from(p.deltaBase64,'base64').toString('utf8');session.truncated||=p.capReached;}
    if(msg.method==='process/exited') {session.running=false;session.exitCode=p.exitCode;session.output+=(p.stdout??'')+(p.stderr??'');session.truncated||=p.stdoutCapReached||p.stderrCapReached;}
  }
  async start(workspace,input,command) {
    const cwd=await this.checkedPath(input.workingDirectory??'.',workspace.root);
    const session={id:this.nextSession++,handle:'bridge_'+randomBytes(10).toString('hex'),workspaceId:workspace.id,output:'',running:true,started:Date.now(),truncated:false};
    this.sessions.set(session.handle,session);
    try {await this.request('process/spawn',{processHandle:session.handle,command,cwd,tty:input.tty??false,streamStdin:true,streamStdoutStderr:true,timeoutMs:((input.timeout??300)*1000),outputBytesCap:1024*1024});}
    catch(e){this.sessions.delete(session.handle);throw e;}
    return session;
  }
  async poll(session,input={}) {
    const deadline=Date.now()+(input.yieldTimeMs??10000);
    while(session.running&&Date.now()<deadline)await delay(Math.min(100,deadline-Date.now()));
    if(session.error)fail('REMOTE_CONNECTION_LOST',session.error);
    const cap=(input.maxOutputTokens??10000)*4;
    const output=session.output.slice(0,cap);session.output=session.output.slice(output.length);
    const result=output+(session.running?`\nProcess running with session ID ${session.id}.`:`\nProcess exited with code ${session.exitCode}.`);
    return {...text(result),structuredContent:{result,sessionId:session.id,running:session.running,...(!session.running?{exitCode:session.exitCode}:{}),wallTimeMs:Date.now()-session.started,outputTruncated:session.truncated||session.output.length>0}};
  }
  async execute(name,input) {
    if(name==='open_workspace')return this.open(input);
    const workspace=this.workspace(input.workspaceId);
    if(name==='read') {
      const path=await this.checkedPath(input.path,workspace.root);
      const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[posix.extname(path).toLowerCase()];
      if(mime){const file=await this.request('fs/readFile',{path});return {content:[{type:'image',data:file.dataBase64,mimeType:mime}],structuredContent:{result:`Read image ${path}`}};}
      return text(await this.read(path,input.offset??1,input.limit??2000));
    }
    if(name==='write') {const path=await this.checkedPath(input.path,workspace.root,{missing:true});await this.request('fs/writeFile',{path,dataBase64:Buffer.from(input.content).toString('base64')});return text(`Wrote ${path}`);}
    if(name==='edit')return this.edit(await this.checkedPath(input.path,workspace.root),input.edits);
    if(name==='ls') {const path=await this.checkedPath(input.path??'.',workspace.root);const entries=(await this.request('fs/readDirectory',{path})).entries;return text(entries.map(entry=>entry.fileName+(entry.isDirectory?'/':'')).sort().join('\n'));}
    if(name==='grep'||name==='glob') {
      const path=await this.checkedPath(input.path??'.',workspace.root);
      const command=name==='grep'?['rg','--no-heading','--with-filename','--line-number',...(input.include?['--glob',input.include]:[]),'--',input.pattern,path]:['rg','--files','--glob',input.pattern,'--',path];
      const result=await this.request('command/exec',{command,cwd:workspace.root,timeoutMs:30000,outputBytesCap:65536});
      if(result.exitCode>1)fail('COMMAND_FAILED','Remote search failed.');return text(result.stdout+result.stderr);
    }
    if(name==='bash') {
      const session=await this.start(workspace,{...input,timeout:input.timeout??30},['bash','-lc',input.command]);
      while(session.running)await delay(100);
      const response=await this.poll(session,{yieldTimeMs:0,maxOutputTokens:16000});
      if(session.exitCode!==0)response.isError=true;return {content:response.content,structuredContent:{result:response.structuredContent.result},...(response.isError?{isError:true}:{})};
    }
    if(name==='exec_command') {const session=await this.start(workspace,input,[input.shell??'/bin/bash',...(input.login===false?['-c']:['-lc']),input.cmd]);return this.poll(session,input);}
    if(name==='write_stdin') {
      const session=[...this.sessions.values()].find(s=>s.id===input.sessionId&&s.workspaceId===workspace.id);
      if(!session)fail('UNKNOWN_PROCESS','Remote process session is unavailable.');
      if(input.chars)await this.request('process/writeStdin',{processHandle:session.handle,deltaBase64:Buffer.from(input.chars).toString('base64')});
      if(input.columns||input.rows)await this.request('process/resizePty',{processHandle:session.handle,size:{cols:input.columns??80,rows:input.rows??24}});
      return this.poll(session,input);
    }
    fail('UNSUPPORTED_REMOTE_TOOL','This optional tool is unavailable for the remote checkout; use the advertised file and command tools.');
  }
  wrap(name,handler,audit=()=>{}) {
    if(!tools.has(name))return handler;
    return async input=>{
      const started=performance.now();let response,errorCode;
      try {response=await this.execute(name,input);if(response.isError)errorCode=name==='bash'?'COMMAND_FAILED':'REMOTE_TOOL_ERROR';}
      catch(e){errorCode=typeof e.code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(e.code)?e.code:'REMOTE_ERROR';response={isError:true,content:[{type:'text',text:JSON.stringify({error:e.code??'REMOTE_ERROR',message:e instanceof BridgeError?e.message:'Remote workspace operation failed.'})}]};}
      audit({tool:name,success:!response.isError,...(errorCode?{errorCode}:{}),durationMs:Math.round(performance.now()-started)});
      return response;
    };
  }
  close(){this.rpc.close();}
}

let singleton;
export function getRemoteWorkspaceBridge(config) {if(!config)return null;return singleton??=new RemoteWorkspaceBridge(config);}
export function closeRemoteWorkspaceBridge(){singleton?.close();}
