import {TEST_CONFIG} from './test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeError, TaskBridge, LEGACY_MODEL_POLICY} from './task-bridge.mjs';

const catalog = {
  project: 'local',
  models: [
    {model: 'gpt-6.1-sol', reasoningEfforts: ['medium', 'high', 'xhigh']},
    {model: 'gpt-6-astra', reasoningEfforts: ['medium', 'high', 'xhigh']},
    {model: 'gpt-5.6-sol', reasoningEfforts: ['medium', 'high']},
  ],
};

function bridge() {
  const b = new TaskBridge({config:TEST_CONFIG,policyReader: async () => LEGACY_MODEL_POLICY, factory: () => ({connect: async () => {}, close() {}})});
  b.models = async () => catalog;
  return b;
}

function mockDispatch(b) {
  const thread={id:'00000000-0000-0000-0000-000000000001',cwd:'/srv/projects/demo',status:{type:'idle'},turns:[]};
  const client={owned:new Set(),blocked:new Map(),handoffs:new Map(),close(){},request:async method=>{
    if(method==='thread/start'||method==='thread/resume')return {thread};
    if(method==='turn/start')return {turn:{id:'mock-turn',status:'inProgress'}};
    return {};
  }};
  b.client=async()=>client;
  b.scoped=async()=>thread;
}

test('omitted execution options default to Sol 6.1 xhigh', async () => {
  assert.deepEqual(await bridge().executionOptions({project: 'local'}), {
    model: 'gpt-6.1-sol', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(await bridge().executionOptions({project: 'local', model: 'gpt-6-astra'}), {
    model: 'gpt-6-astra', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(await bridge().executionOptions({project: 'local', reasoningEffort: 'high'}), {
    model: 'gpt-6.1-sol', reasoningEffort: 'high',
  });
});

test('catalog descriptors report a supported per-model default', async () => {
  const b = new TaskBridge({config:TEST_CONFIG,policyReader: async () => LEGACY_MODEL_POLICY, factory: () => ({
    connect: async () => {}, close() {},
    request: async () => ({data: [
      {model: 'gpt-5.6-sol', description: '', isDefault: false,
        supportedReasoningEfforts: [{reasoningEffort: 'medium'}, {reasoningEffort: 'high'}]},
    ]}),
  })});
  const listed = await b.models({project: 'local'});
  assert.deepEqual(listed.models[0].reasoningEfforts, ['medium', 'high']);
  assert.equal(listed.models[0].defaultReasoningEffort, 'high');
  assert.ok(listed.models[0].reasoningEfforts.includes(listed.models[0].defaultReasoningEffort));
});

test('explicit model and effort overrides are preserved', async () => {
  assert.deepEqual(await bridge().executionOptions({project: 'local', model: 'gpt-5.6-sol', reasoningEffort: 'high'}), {
    model: 'gpt-5.6-sol', reasoningEffort: 'high',
  });
  assert.deepEqual(await bridge().executionOptions({project: 'local', model: 'gpt-6-astra', reasoningEffort: 'medium'}), {
    model: 'gpt-6-astra', reasoningEffort: 'medium',
  });
});

test('create and send without stored execution use Sol 6.1 xhigh', async () => {
  for (const kind of ['create', 'send']) {
    const b = bridge();
    mockDispatch(b);
    b.journal = async (_id, _input, callback) => callback(async () => {}, {});
    const args = {project: 'local', prompt: 'hello', requestId: `${kind}_1234`};
    if (kind === 'create') args.title = 'new task';
    else args.threadId = '00000000-0000-0000-0000-000000000001';
    assert.deepEqual((await b.mutate(kind, args)).submittedExecution, {model: 'gpt-6.1-sol', reasoningEffort: 'xhigh'});
  }
});

test('unavailable models and unsupported efforts fail with stable codes', async () => {
  await assert.rejects(() => bridge().executionOptions({project: 'local', model: 'missing'}),
    e => e instanceof BridgeError && e.code === 'MODEL_UNAVAILABLE');
  await assert.rejects(() => bridge().executionOptions({project: 'local', model: 'gpt-5.6-sol'}),
    e => e instanceof BridgeError && e.code === 'UNSUPPORTED_REASONING_EFFORT');
});

test('retry records retain their persisted execution instead of applying new defaults', async () => {
  const b = bridge();
  const persisted = {model: 'gpt-5.6-sol', reasoningEffort: 'medium'};
  let executionOptionsCalled = false;
  b.executionOptions = async () => { executionOptionsCalled = true; throw new Error('must not resolve retry defaults'); };
  mockDispatch(b);
  b.journal = async (_id, _input, callback) => callback(async () => {}, {execution: persisted});
  const result = await b.mutate('create', {project: 'local', title: 'retry', prompt: 'continue', requestId: 'retry_1234'});
  assert.equal(executionOptionsCalled, false);
  assert.strictEqual(result.submittedExecution, persisted);
});
