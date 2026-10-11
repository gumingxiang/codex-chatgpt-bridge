import {BRIDGE_CONFIG} from './bridge-config.mjs';
import {registerTaskTools} from './task-bridge.mjs';
import {getRemoteWorkspaceBridge,closeRemoteWorkspaceBridge} from './remote-workspace.mjs';

let tasks;
// Called before upstream workspace tools are registered. Native file tools stay upstream.
export function attachBridge(server,z,audit=()=>{}) {
  tasks=registerTaskTools(server,z);
  const project=BRIDGE_CONFIG.remoteWorkspaceProject;
  if(!project)return tasks;
  const remote=getRemoteWorkspaceBridge({project,root:BRIDGE_CONFIG.projects[project].cwd});
  const register=server.registerTool.bind(server);
  server.registerTool=(name,descriptor,handler)=>register(name,descriptor,remote.wrap(name,handler,audit));
  return tasks;
}

export function closeBridge() {tasks?.close();closeRemoteWorkspaceBridge();}
