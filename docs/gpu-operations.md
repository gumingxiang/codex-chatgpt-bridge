# GPU 配置、运维和迁移

先识别当前实际部署目录、服务账户、SSH Host、公共 URL 和唯一生命周期 owner。本文的 `gpu-server`、`bridge-vps`、`/srv/projects/demo` 及 `%h` 路径均是模板；不能照抄另一台机器的用户、IP、VSCode Node 路径、UID 或 SSH alias。现有实例先只读查看配置和 unit，不自动更换它的 owner。

## 配置

部署布局见 [接入说明](../integration/README.md)。在服务账户的 `$HOME/.config/codex-chatgpt-bridge/` 放置：

- `config.json`：从 examples/devspace-config.example.json 复制，调整 host/port、publicBaseUrl、allowedRoots、stateDir；只绑定 loopback。示例与 unit 使用同一账户的 ~/.local/share/codex-chatgpt-bridge/state；调整时保持一致，环境变量优先。
- `bridge-config.json`：从 examples/bridge-config.example.json 复制，项目 cwd 必须是窄的绝对 Linux 路径。native 的 cwd 属于运行服务的 GPU；SSH 模式使用项目 Host、既有 SSH config 及 remoteCodex。需要指定 SSH config 时使用 `sshConfig`。localAlias 仅兼容明确指定的项目。
- `model-policy.json`：从 examples/model-policy.example.json 复制。仅包含模型/effort allowlist 与默认值，无凭据；原子替换该文件后下一次任务调用读取新策略，不需要重启。
- `auth.json`：由独立 DevSpace init 生成，包含 Owner password，保持私有。不要放进公共示例、聊天或 git。

`CODEX_TASK_BRIDGE_CONFIG`、`CODEX_TASK_BRIDGE_MODEL_POLICY`、`CODEX_TASK_BRIDGE_STATE_DIR` 指向上述文件和私人 journal 目录。`CODEX_TASK_BRIDGE_TRANSPORT` / `CODEX_TASK_BRIDGE_CODEX` 可覆盖已存在传输/原生 Codex 入口；检查 unit/env 是否覆盖 JSON。检查 `HOST`、`PORT`、`DEVSPACE_*` 和六个大小写 proxy 环境变量，不修改全局环境。现有正常 SSH 跳板保留。

模型策略不会扩大新任务权限。示例没有 `taskPermissions`，create/send 会拒绝；开放派发需操作者显式设置 approvalPolicy 和 sandbox，并由用户授权具体任务。跟进只 resume 既有任务，不覆盖其权限。运行中任务拒绝跟进；交互请求不自动批准。目录匹配不能限制任意 shell 的服务账户权限。可选 remoteWorkspaceProject 只映射指定根，open/read/write 等工具拒绝词法和 realpath symlink 越界；默认 null 保持上游 GPU 本地文件路径。

## 单一 owner 与开关

将 linux/ 两个 `.service.example` 审阅后复制为同一服务账户的 `$HOME/.config/systemd/user/codex-chatgpt-bridge.service` 和 `codex-chatgpt-bridge-tunnel.service`。更换 Node、部署和 project 路径，配置现有 bridge-vps Host/known_hosts/key。远端只绑定 loopback，公共 HTTPS 反向代理由操作者另行维护。需要账户登出后运行时由管理员按实际政策配置 user lingering。

以下操作在目标服务账户下执行，例如 `ssh gpu-server 'systemctl --user …'`；SSH 登录账户必须与 unit owner 一致。不要用 root 的 systemd 操作另一个账户的 user unit。

```bash
# 只读 Status / Doctor 起点
systemctl --user is-enabled codex-chatgpt-bridge.service codex-chatgpt-bridge-tunnel.service
systemctl --user is-active codex-chatgpt-bridge.service codex-chatgpt-bridge-tunnel.service
systemctl --user status codex-chatgpt-bridge.service codex-chatgpt-bridge-tunnel.service --no-pager
```

Doctor 还需在实际 URL 检查 OAuth metadata、未授权 `/mcp` 拒绝访问，并完成授权只读调用；systemd active 本身不是 MCP 可用证据。

```bash
# 显式 On：已安装/审阅配置之后才执行
systemctl --user daemon-reload
systemctl --user enable --now codex-chatgpt-bridge.service codex-chatgpt-bridge-tunnel.service

# 显式持久 Off：保留授权、配置、journal
systemctl --user disable --now codex-chatgpt-bridge-tunnel.service codex-chatgpt-bridge.service
```

普通 stop 会保留 enabled 状态，不能替代持久 Off。Restart/Reboot 前先核对两 unit 都 enabled + active，并交回 bridge 持有的任务；主动 Off 后不能自动 On。符合条件且用户授权恢复时才执行：

```bash
systemctl --user restart codex-chatgpt-bridge.service codex-chatgpt-bridge-tunnel.service
```

同时检查两 unit 与实际 MCP 只读访问。Windows controller 只用于已选择的 Windows 模式/回退；GPU owner 活跃时不同时开启 Windows tunnel 或第二条反向转发。回退先停止当前 owner，再按对应模式的健康检查启动另一个 owner。

## SQLite、迁移与回退

DevSpace 1.0.8 的授权持久化在实际 `stateDir/devspace.sqlite`，同库还有 workspace 等运行记录。`DEVSPACE_STATE_DIR` / config.stateDir 优先于默认 `$HOME/.local/share/devspace`。Owner password/config 与 SQLite 是不同材料；task bridge 的 requestId journal 又在 CODEX_TASK_BRIDGE_STATE_DIR。

备份包含 config/auth、模型策略、实际 stateDir、task-state，以及 unit 和版本信息。运行时只复制 `devspace.sqlite` 可能遗漏 WAL；使用 SQLite 一致 backup，或在明确停机授权、任务交回后停止唯一 owner，再备份完整 stateDir。不要把备份加入仓库。Off 保留授权，不代表撤销客户端；删除旧 oauth-state.json 也不能泛化为 SQLite 版 Rotate。撤销/轮换需单独授权并核实当前 runtime 的实际支持流程。

迁移前先一致备份，记录双方版本/实际 stateDir 和来源。不要合并两个独立实例的 DB 或 journal，不自动导入旧 OAuth JSON。用备份副本核验新 runtime 与 SQLite binding 后，在维护窗口交回任务、关闭旧 owner，再使用新配置启动；公共 URL、Owner 与客户端材料是否保留必须逐项核对。升级可能改变 DB schema，回退使用成套旧 runtime/config/state 备份，不把降级 runtime 直接指向已升级的 DB。保留未知/dispatching journal 并人工核对任务，避免迁移后以新 requestId 重发。

部署改变 advertised 工具时刷新 ChatGPT metadata、新会话检查；URL 改变时重新连接。只修改本机 skill 或公开仓库 candidate 不改变生产版本、OAuth、model policy 或现有连接。
