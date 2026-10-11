import {TEST_CONFIG} from './test-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Rpc,PROJECTS} from './task-bridge.mjs';

function fixture(project,options={}) {
  const launches=[],requests=[],messages=[];
  const child=new EventEmitter();
  child.stdin=new EventEmitter();
  child.stdin.write=()=>true;
  child.kill=()=>{};
  const rpc=new Rpc(project,{config:TEST_CONFIG,...options,spawnProcess:(executable,args,configuration)=>{launches.push({executable,args,configuration});return child;}});
  let upgrades=0;
  rpc.websocket=async()=>{upgrades++;rpc.send=message=>messages.push(message);};
  rpc.request=async(method,params)=>{requests.push({method,params});return {};};
  return {rpc,launches,requests,messages,get upgrades(){return upgrades;}};
}

test('native GPU routes use the existing local Codex proxy and WebSocket initialization once',async()=>{
  for(const project of [...Object.keys(TEST_CONFIG.projects),'local']) {
    const f=fixture(project,{transport:'native'});
    await f.rpc.connect();
    await f.rpc.connect();
    assert.equal(f.launches.length,1);
    assert.equal(f.launches[0].executable,'/opt/codex/bin/codex');
    assert.deepEqual(f.launches[0].args,['app-server','proxy']);
    assert.equal(f.upgrades,1);
    assert.equal(f.requests.length,1);
    assert.equal(f.requests[0].method,'initialize');
    assert.deepEqual(f.messages,[{method:'initialized'}]);
    assert.equal(f.launches[0].configuration.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,undefined);
  }
});

test('explicit SSH transport retains the Windows executable and configured jump route',async()=>{
  const f=fixture('locavate_remote',{transport:'ssh',sshConfig:'existing-ssh-config'});
  await f.rpc.connect();
  assert.equal(f.launches[0].executable,'ssh');
  assert.deepEqual(f.launches[0].args.slice(0,2),['-F','existing-ssh-config']);
  assert.deepEqual(f.launches[0].args.slice(-2),['gpu-server',"exec '/opt/codex/bin/codex' app-server proxy"]);
  assert.equal(f.upgrades,1);
});

test('unknown transports fail before process creation',()=>{
  assert.throws(()=>new Rpc('locavate_remote',{config:TEST_CONFIG,transport:'invalid'}),error=>error.code==='INVALID_TRANSPORT');
});
