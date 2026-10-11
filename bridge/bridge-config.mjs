import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {posix} from 'node:path';

const invalid = message => {const error=new Error('Invalid bridge configuration: '+message);error.code='BRIDGE_CONFIG_INVALID';throw error;};
const string = value => typeof value==='string' && value.length>0 && !/[\0\r\n]/.test(value);

// Operator-owned configuration only. No credentials or implicit execution grant.
export function validateBridgeConfig(value) {
  if(!value || typeof value!=='object' || Array.isArray(value)) invalid('expected an object.');
  const projects={};
  if(!value.projects || typeof value.projects!=='object' || Array.isArray(value.projects)) invalid('projects must be an object.');
  for(const [name,project] of Object.entries(value.projects)) {
    if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || !project || typeof project!=='object') invalid('invalid project.');
    if(!string(project.cwd) || !posix.isAbsolute(project.cwd) || project.cwd.includes('\\') || posix.normalize(project.cwd)==='/') invalid('project cwd must be a narrow absolute Linux path.');
    if(project.host!==undefined && (!string(project.host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(project.host))) invalid('invalid SSH host.');
    projects[name]=Object.freeze({cwd:posix.normalize(project.cwd).replace(/\/$/,''),...(project.host?{host:project.host}:{})});
  }
  const localAlias=value.localAlias??null;
  if(localAlias!==null && (!Object.hasOwn(projects,localAlias) || localAlias==='local' || Object.hasOwn(projects,'local'))) invalid('localAlias must name a configured non-local project.');
  const transport=value.transport??'ssh';
  if(!['ssh','native'].includes(transport)) invalid('transport must be ssh or native.');
  for(const name of ['nativeCodex','remoteCodex','sshExecutable','sshConfig']) if(value[name]!==undefined && !string(value[name])) invalid(name+' must be nonempty.');
  const taskPermissions=value.taskPermissions??null;
  if(taskPermissions!==null && (!taskPermissions || !['untrusted','on-request','on-failure','never'].includes(taskPermissions.approvalPolicy) || !['read-only','workspace-write','danger-full-access'].includes(taskPermissions.sandbox))) invalid('taskPermissions must explicitly set approvalPolicy and sandbox.');
  const remoteWorkspaceProject=value.remoteWorkspaceProject??null;
  if(remoteWorkspaceProject!==null && !Object.hasOwn(projects,remoteWorkspaceProject)) invalid('remoteWorkspaceProject must name a configured project.');
  return Object.freeze({...value,projects:Object.freeze(projects),localAlias,transport,taskPermissions:taskPermissions===null?null:Object.freeze({approvalPolicy:taskPermissions.approvalPolicy,sandbox:taskPermissions.sandbox}),remoteWorkspaceProject});
}

export function loadBridgeConfig(path=process.env.CODEX_TASK_BRIDGE_CONFIG??fileURLToPath(new URL('../bridge-config.json',import.meta.url))) {
  try {return validateBridgeConfig(JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,'')));}
  catch(error) {if(error.code==='ENOENT' && arguments.length===0 && !process.env.CODEX_TASK_BRIDGE_CONFIG) return validateBridgeConfig({projects:{}});throw error;}
}

export const BRIDGE_CONFIG=loadBridgeConfig();
