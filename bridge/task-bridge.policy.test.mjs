import {TEST_CONFIG} from './test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TaskBridge,validateModelPolicy,readModelPolicy,LEGACY_MODEL_POLICY} from './task-bridge.mjs';

const policy=(extra={})=>({...LEGACY_MODEL_POLICY,allowedModels:['gpt-6.1-sol','gpt-6-luna'],...extra});
const models=[{model:'gpt-6.1-sol',description:'sol',supportedReasoningEfforts:['low','medium','high','xhigh','max','ultra'].map(reasoningEffort=>({reasoningEffort}))},{model:'gpt-6-luna',description:'luna',supportedReasoningEfforts:['low','medium','high','xhigh','max'].map(reasoningEffort=>({reasoningEffort}))},{model:'excluded',supportedReasoningEfforts:[{reasoningEffort:'high'}]}];
function fixture(value=policy()){
  let reads=0,submitted=0;
  const b=new TaskBridge({config:TEST_CONFIG,policyReader:async()=>{reads++;return value;},factory:()=>({connect:async()=>{},close(){},request:async method=>{assert.equal(method,'model/list');return {data:models};}})});
  b.journal=async(_id,_payload,fn)=>fn(async()=>{},{});
  b.desktopMutate=async()=>{submitted++;};
  return {b,get reads(){return reads;},get submitted(){return submitted;}};
}
test('configured catalog filters models and efforts and reports configured defaults',async()=>{
  const {b}=fixture(policy({allowedModels:['gpt-6-luna'],allowedReasoningEfforts:['low','max'],defaultModel:'gpt-6-luna',defaultReasoningEffort:'max'}));
  const result=await b.models({project:'local'});
  assert.equal(result.project,'locavate_remote');assert.equal(result.models.length,1);
  assert.deepEqual(result.models[0].reasoningEfforts,['low','max']);
  assert.equal(result.models[0].isDefault,true);assert.equal(result.models[0].defaultReasoningEffort,'max');
  assert.deepEqual(await b.executionOptions({project:'remote'}),{model:'gpt-6-luna',reasoningEffort:'max'});
});
test('reject model and effort outside allowlists before submission',async()=>{
  const {b}=fixture();
  await assert.rejects(()=>b.executionOptions({project:'remote',model:'excluded'}),e=>e.code==='MODEL_NOT_ALLOWED');
  await assert.rejects(()=>b.executionOptions({project:'remote',reasoningEffort:'ultra'}),e=>e.code==='REASONING_NOT_ALLOWED');
});
test('known effort unsupported by selected model is rejected; highest is intersected',async()=>{
  const {b}=fixture(policy({allowedReasoningEfforts:['low','xhigh','max','ultra'],defaultReasoningEffort:'xhigh'}));
  await assert.rejects(()=>b.executionOptions({project:'remote',model:'gpt-6-luna',reasoningEffort:'ultra'}),e=>e.code==='UNSUPPORTED_REASONING_EFFORT');
  assert.deepEqual(await b.executionOptions({project:'remote',model:'gpt-6-luna',reasoningEffort:'highest'}),{model:'gpt-6-luna',reasoningEffort:'max'});
});
test('policy snapshots are read once per execution options operation',async()=>{
  const f=fixture();await f.b.executionOptions({project:'remote'});assert.equal(f.reads,1);
});
test('missing policy preserves original behavior; malformed and invalid fail closed',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'model-policy-test-'));const file=join(dir,'policy.json');
  try{
    assert.deepEqual(await readModelPolicy(file),LEGACY_MODEL_POLICY);
    await writeFile(file,'{broken');await assert.rejects(()=>readModelPolicy(file),e=>e.code==='MODEL_POLICY_INVALID');
    for(const invalid of [policy({allowedModels:[]}),policy({defaultModel:'excluded'}),policy({allowedReasoningEfforts:['unknown']}),policy({defaultReasoningEffort:'ultra'})])assert.throws(()=>validateModelPolicy(invalid),e=>e.code==='MODEL_POLICY_INVALID');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('dynamic policy changes affect next call without module reload',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'model-policy-dynamic-'));const file=join(dir,'policy.json');
  try{
    const f=fixture();f.b.policyReader=readModelPolicy;f.b.policyPath=file;
    await writeFile(file,JSON.stringify(policy()));assert.equal((await f.b.executionOptions({project:'remote'})).reasoningEffort,'xhigh');
    await writeFile(file,JSON.stringify(policy({allowedReasoningEfforts:['low'],defaultReasoningEffort:'low'})));
    assert.equal((await f.b.executionOptions({project:'remote'})).reasoningEffort,'low');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('persisted execution revalidates changed policy before any remote thread/turn operation',async()=>{
  for(const [execution,code] of [[{model:'excluded',reasoningEffort:'high'},'MODEL_POLICY_CHANGED'],[{model:'gpt-6.1-sol',reasoningEffort:'ultra'},'REASONING_POLICY_CHANGED']]){
    const f=fixture();f.b.journal=async(_id,_payload,fn)=>fn(async()=>{},{execution});
    await assert.rejects(()=>f.b.mutate('create',{project:'local',title:'unit fixture',prompt:'unit fixture',requestId:'fixture_1234'}),e=>e.code===code);
    assert.equal(f.reads,1);assert.equal(f.submitted,0);
  }
});
test('journal accepted replay never dispatches again even after policy narrows',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'model-policy-journal-'));const {b}=fixture();b.stateDir=dir;
  // Exercise the real journal with an in-memory callback, never a production RPC.
  delete b.journal;let dispatches=0;
  const payload={kind:'create',project:'remote',title:'fixture',prompt:'fixture'};
  try{
    await b.journal('journal_1234',payload,async()=>{dispatches++;return {accepted:true,threadId:'mock'};});
    const result=await b.journal('journal_1234',payload,async()=>{throw new Error('must not dispatch');});
    assert.equal(result.replayed,true);assert.equal(dispatches,1);
    await assert.rejects(()=>b.journal('journal_1234',{...payload,prompt:'changed'},async()=>{}),e=>e.code==='REQUEST_ID_CONFLICT');
    assert.equal(JSON.parse(await readFile(join(dir,'journal_1234.json'),'utf8')).state,'accepted');
  }finally{await rm(dir,{recursive:true,force:true});}
});
