import {validateBridgeConfig} from './bridge-config.mjs';

export const TEST_CONFIG=validateBridgeConfig({
  projects:{locavate_remote:{cwd:'/srv/projects/demo',host:'gpu-server'},remote:{cwd:'/srv/projects/secondary',host:'gpu-server'}},
  localAlias:'locavate_remote',nativeCodex:'/opt/codex/bin/codex',remoteCodex:'/opt/codex/bin/codex',sshExecutable:'ssh',
  taskPermissions:{approvalPolicy:'on-request',sandbox:'workspace-write'}
});
