import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateBridgeConfig,loadBridgeConfig} from './bridge-config.mjs';
import {Rpc,TaskBridge,canonicalProject,LEGACY_MODEL_POLICY} from './task-bridge.mjs';
import {TEST_CONFIG} from './test-fixture.mjs';

test('operator configuration has no implicit dispatch grant; invalid scopes/options fail',()=>{
  const config=validateBridgeConfig({projects:{demo:{cwd:'/srv/demo'}}});
  assert.equal(config.taskPermissions,null);
  assert.equal(canonicalProject('local',config),'local');
  for(const value of [{projects:{demo:{cwd:'relative'}}},{projects:{demo:{cwd:'/'}}},{projects:{demo:{cwd:'/srv/demo',host:'-bad'}}},{projects:{},localAlias:'missing'},{projects:{},taskPermissions:{sandbox:'danger-full-access'}},{projects:{},remoteWorkspaceProject:'missing'}])assert.throws(()=>validateBridgeConfig(value),e=>e.code==='BRIDGE_CONFIG_INVALID');
  assert.throws(()=>loadBridgeConfig(join(tmpdir(),'nonexistent-bridge-config-fixture.json')),e=>e.code==='ENOENT');
});

test('configured native executable, SSH host/path and legacy local alias are reused',()=>{
  const config=validateBridgeConfig({...TEST_CONFIG,projects:{demo:{cwd:'/srv/custom',host:'different-host'}},localAlias:'demo',remoteCodex:"/opt/codex' quote/bin/codex"});
  const rpc=new Rpc('local',{config,transport:'ssh'});
  assert.equal(rpc.project,'demo');
  assert.deepEqual(rpc.remoteArguments().slice(-2),['different-host',"exec '/opt/codex'\\'' quote/bin/codex' app-server proxy"]);
  assert.equal(canonicalProject('local',config),'demo');
  assert.throws(()=>new Rpc('missing',{config}),e=>e.code==='INVALID_PROJECT');
});

test('create/send without taskPermissions cannot reach a backend',async()=>{
  const b=new TaskBridge({config:validateBridgeConfig({...TEST_CONFIG,taskPermissions:null}),factory:()=>{throw Error('backend must not launch');}});
  b.journal=async(_id,_payload,fn)=>fn(async()=>{},{});
  for(const kind of ['create','send'])await assert.rejects(()=>b.mutate(kind,{project:'local',title:'fixture',prompt:'fixture',requestId:'no_grant_1234',threadId:'00000000-0000-0000-0000-000000000001'}),e=>e.code==='TASK_DISPATCH_DISABLED');
});

test('new tasks use only explicit permission fields; follow-ups do not change them',async()=>{
  const requests=[];
  const config=validateBridgeConfig({...TEST_CONFIG,taskPermissions:{approvalPolicy:'never',sandbox:'danger-full-access',cwd:'/out-of-scope'}});
  const thread={id:'00000000-0000-0000-0000-000000000001',cwd:TEST_CONFIG.projects.locavate_remote.cwd,status:{type:'idle'},turns:[]};
  const client={owned:new Set(),blocked:new Map(),handoffs:new Map(),connect:async()=>{},close(){},request:async(method,params)=>{
    requests.push({method,params});
    if(['thread/start','thread/read','thread/resume'].includes(method))return {thread};
    if(method==='thread/turns/list')return {data:[]};
    if(method==='turn/start')return {turn:{id:'mock-turn',status:'inProgress'}};
    return {};
  }};
  const b=new TaskBridge({config,factory:()=>client,policyReader:async()=>LEGACY_MODEL_POLICY});
  b.models=async()=>({models:[{model:'gpt-6.1-sol',reasoningEfforts:['xhigh']}]});
  b.journal=async(_id,_payload,fn)=>fn(async()=>{},{});
  await b.mutate('create',{project:'local',title:'fixture',prompt:'fixture',requestId:'create_permissions_1234'});
  const start=requests.find(x=>x.method==='thread/start').params;
  assert.equal(start.cwd,thread.cwd);assert.equal(start.approvalPolicy,'never');assert.equal(start.sandbox,'danger-full-access');
  requests.length=0;
  await b.mutate('send',{project:'local',threadId:thread.id,prompt:'fixture',requestId:'send_permissions_1234'});
  const resume=requests.find(x=>x.method==='thread/resume').params;
  assert.deepEqual(resume,{threadId:thread.id});
  assert.equal(requests.some(x=>x.method==='thread/start'),false);
});

test('accepted journal replay survives disabled dispatch; unresolved records stay unknown',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-config-journal-'));
  const config=validateBridgeConfig({...TEST_CONFIG,taskPermissions:null});
  const b=new TaskBridge({config,stateDir:dir,factory:()=>{throw Error('no production backend');}});
  const a={project:'local',title:'fixture',prompt:'fixture',requestId:'accepted_permissions_1234'};
  const payload={kind:'create',...a,project:'locavate_remote'};
  try{
    await b.journal(a.requestId,payload,async()=>({accepted:true,threadId:'mock'}));
    assert.equal((await b.mutate('create',a)).replayed,true);
    await assert.rejects(()=>b.journal('unknown_permissions_1234',payload,async checkpoint=>{await checkpoint('dispatching');throw Error('reply lost');}));
    await assert.rejects(()=>b.journal('unknown_permissions_1234',payload,async()=>{throw Error('must not dispatch');}),e=>e.code==='OUTCOME_UNKNOWN');
  }finally{await rm(dir,{recursive:true,force:true});}
});

for(const transport of ['native','ssh'])test(`configured local project uses ${transport} for default registration and create/send/release`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bridge-local-route-'));
  const configFile=join(dir,'config.json');
  try {
    await writeFile(configFile,JSON.stringify({projects:{local:{cwd:'/srv/demo',host:'gpu-server'}},transport,nativeCodex:'/opt/codex/bin/codex',taskPermissions:{approvalPolicy:'on-request',sandbox:'workspace-write'}}));
    const source=`
      import assert from 'node:assert/strict';
      import {EventEmitter} from 'node:events';
      const {registerTaskTools,Rpc}=await import(${JSON.stringify(new URL('./task-bridge.mjs',import.meta.url).href)});
      let schema;schema=new Proxy({}, {get:()=>()=>schema});
      const z=new Proxy({}, {get:()=>()=>schema});
      const tools=[];const b=registerTaskTools({registerTool(name){tools.push(name);}},z);
      assert.equal(b.desktop,null);assert.equal(b.config.localAlias,null);assert.equal(tools.length,6);
      const launches=[];const child=new EventEmitter();child.stdin=new EventEmitter();child.kill=()=>{};
      const rpc=new Rpc('local',{config:b.config,spawnProcess:(executable,args)=>{launches.push({executable,args});return child;}});
      rpc.websocket=async()=>{rpc.send=()=>{};};rpc.request=async()=>({});await rpc.connect();
      assert.equal(launches[0].executable,${JSON.stringify(transport==='native'?'/opt/codex/bin/codex':'ssh')});
      const thread={id:'00000000-0000-0000-0000-000000000001',cwd:'/srv/demo',status:{type:'idle'},turns:[]};
      const requests=[];let closes=0;
      const c={alive:true,owned:new Set(),blocked:new Map(),handoffs:new Map(),connect:async()=>{},close(){closes++;},request:async(method,params)=>{
        requests.push({method,params});
        if(['thread/start','thread/read','thread/resume'].includes(method))return {thread};
        if(method==='thread/turns/list')return {data:[]};
        if(method==='turn/start')return {turn:{id:'fixture',status:'inProgress'}};
        if(method==='thread/unsubscribe')return {status:'unsubscribed'};
        return {};
      }};
      b.factory=()=>c;b.models=async()=>({models:[{model:'gpt-6.1-sol',reasoningEfforts:['xhigh']}]});
      b.journal=async(_id,_payload,fn)=>fn(async()=>{},{});
      await b.mutate('create',{project:'local',title:'fixture',prompt:'fixture',requestId:'local_create_1234'});
      await b.mutate('send',{project:'local',threadId:thread.id,prompt:'fixture',requestId:'local_send_1234'});
      const released=await b.release({project:'local',threadId:thread.id});
      assert.equal(released.released,true);assert.equal(released.state,'released');assert.equal(closes,1);
      for(const method of ['thread/start','thread/resume','turn/start','thread/unsubscribe'])assert(requests.some(r=>r.method===method),method);
      rpc.close();
    `;
    await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{env:{...process.env,CODEX_TASK_BRIDGE_CONFIG:configFile,CODEX_TASK_BRIDGE_TRANSPORT:transport},windowsHide:true});
  } finally {await rm(dir,{recursive:true,force:true});}
});
