import test from 'node:test';
import assert from 'node:assert/strict';
import {RemoteWorkspaceBridge} from './remote-workspace.mjs';
import {TEST_CONFIG} from './test-fixture.mjs';

test('configured remote root refuses lexical escapes and a foreign config root',()=>{
  const bridge=new RemoteWorkspaceBridge({project:'locavate_remote',root:'/srv/projects/demo'},{bridgeConfig:TEST_CONFIG,rpc:{}});
  assert.equal(bridge.path('gpu-server:src/code.mjs'),'/srv/projects/demo/src/code.mjs');
  for(const path of ['../secondary','/etc/passwd','~/.config','C:\\Users\\example','src\0file'])assert.throws(()=>bridge.path(path),e=>e.code==='OUT_OF_SCOPE');
  assert.throws(()=>new RemoteWorkspaceBridge({project:'locavate_remote',root:'/srv/other'},{bridgeConfig:TEST_CONFIG,rpc:{}}),e=>e.code==='INVALID_REMOTE_CONFIG');
});

test('realpath symlink escapes are rejected before any file access',async()=>{
  const calls=[];
  const rpc={connect:async()=>{},request:async(method,params)=>{calls.push({method,params});return {exitCode:0,stdout:'/etc/private\n'};}};
  const bridge=new RemoteWorkspaceBridge({project:'locavate_remote',root:'/srv/projects/demo'},{bridgeConfig:TEST_CONFIG,rpc});
  await assert.rejects(()=>bridge.checkedPath('symlink'),e=>e.code==='OUT_OF_SCOPE');
  assert.deepEqual(calls.map(x=>x.method),['command/exec']);
  assert.deepEqual(calls[0].params.command,['realpath','-e','--','/srv/projects/demo/symlink']);
});
