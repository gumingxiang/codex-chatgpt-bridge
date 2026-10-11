# Codex ChatGPT Bridge

通过 DevSpace MCP 访问项目，并在操作者指定的 Linux/GPU 项目中读取 Codex 任务、查询模型，以及在用户明确授权后创建任务、发送跟进消息和交回执行权。直连版运行在 GPU 上；Windows 的四个生命周期脚本仍保留。

```text
ChatGPT → HTTPS + OAuth + MCP → GPU DevSpace → 项目文件与 shell 工具
                                           → task-bridge → 本机 Codex app-server proxy (native)
                                                        → 既有 SSH Host 的 Codex proxy (ssh)
```

`bridge/` 是独立扩展，`integration/` 提供 DevSpace **1.0.8** 的小接入 patch 和离线协议 smoke，`linux/` 提供两份 user systemd 示例。DevSpace 仍由操作者独立安装；仓库不分发完整 runtime、原生 binding、依赖目录或运行状态。没有新增 GUI、管理 API 或安装器。

## GPU 直连接入

先按 [固定版本接入说明](integration/README.md) 准备独立 runtime，再按 [GPU 运维与迁移说明](docs/gpu-operations.md) 配置项目、权限、OAuth 状态和唯一生命周期 owner。需要 Node `>=22.19 <27`、Codex、Git 和已配置的 HTTPS 入口；SSH 模式另外需要 OpenSSH 和已授权的 Host。示例中所有 Host、目录、URL、Node/Codex 路径都需由操作者替换。

| MCP 工具 | 行为 |
| --- | --- |
| `codex_list_tasks` / `codex_read_task` | 只读指定项目的任务、可见用户/助手回复与交回状态 |
| `codex_list_models` | 只读可用模型和当前模型策略 |
| `codex_create_task` | 显式授权后创建任务；使用操作者配置的新任务权限 |
| `codex_send_message` | 显式授权后跟进空闲任务；保留原任务权限 |
| `codex_release_task` | 交回 bridge 订阅；中断运行任务另需明确授权 |

复制 [bridge 配置示例](examples/bridge-config.example.json) 后指定真实项目映射。`native` 使用运行服务账户的 Codex proxy，`ssh` 使用项目的既有 Host；二者都不隐式转到 Windows 桌面。`localAlias` 只在明确配置时兼容旧 `local` 调用；实际名为 `local` 的项目同样按配置传输执行。桌面模块保留静态依赖，只有调用方显式注入适配器时才使用。

示例未设置 `taskPermissions`，所以 create/send 默认拒绝派发。操作者如需开放，显式添加例如：

```json
"taskPermissions": {"approvalPolicy": "on-request", "sandbox": "workspace-write"}
```

`never` / `danger-full-access` 也可显式选择，但没有配置时不隐式授予它们。工具授权仍必须来自用户。Bridge 不自动批准交互请求；任务目录匹配和文件根目录检查不构成任意 shell 的 OS 沙箱。

[模型策略示例](examples/model-policy.example.json) 保留 allowlist、默认值和下一次调用生效的语义。策略文件每次任务操作读取一次；已持久化重试保留原执行参数并重新验证。模型必须同时满足策略和当前主机目录，`highest` 取支持能力与 allowlist 的交集。缺失策略使用兼容默认 `gpt-6.1-sol/xhigh`；生产部署应安装明确策略。该 ID 在操作者账户上的可用性以 `codex_list_models` 为准。

重试始终复用相同 `requestId` 与参数。已接受请求返回原结果；结果未知时先核对任务和 journal，不能换 ID 重发。`remoteWorkspaceProject` 默认关闭，GPU 本地文件仍走上游 DevSpace；跨主机文件适配仅对显式选择的一个已配置根生效，并拒绝词法和 symlink 越界。

## 验证

```bash
npm ci --ignore-scripts
npm test
node integration/smoke.mjs /path/to/independent/devspace/package.json
git diff --check
```

测试覆盖 native/SSH、权限未配置拒绝、新任务权限与跟进不覆盖、模型策略、重放/UNKNOWN、根与 symlink 边界及 `local` 项目路由。smoke 使用真实 MCP SDK 和离线后端；不创建模型任务、OAuth 客户端或公共通道。它不替代部署后的授权只读验收。

部署后若新增工具或修改 advertised metadata，在 ChatGPT 刷新连接 metadata 并用新会话检查工具列表；公共 URL 变化时重新连接。单独更新本机 skill 或本仓库文件不会切换现有生产实例，也不要求既有私人连接重新配置。

## Windows 模式安装

Windows 需要 Node、npm、Git Bash 和 Windows PowerShell。下面使用 DevSpace `1.0.8`，其 Node 要求为 `>=22.19 <27`。

```powershell
npm install -g @waishnav/devspace@1.0.8
git clone 'https://github.com/gumingxiang/codex-chatgpt-bridge.git' 'codex-chatgpt-bridge'
Set-Location -LiteralPath '.\codex-chatgpt-bridge'
$controller = Join-Path (Get-Location).Path 'scripts\bridge_controller.ps1'
$runtime = Join-Path (Get-Location).Path 'scripts\local_bridge.ps1'
powershell.exe -NoProfile -File $runtime -Action Doctor
```

脚本使用 `%APPDATA%\npm\devspace.cmd` 和 `C:\Program Files\Git\bin`，请确认实际安装位置。运行时状态和日志默认放在 `%LOCALAPPDATA%\devspace-bridge`，DevSpace 配置写到 `$HOME\.devspace`，不应提交到仓库。启动会覆盖 DevSpace config 中的 host、port、allowedRoots、publicBaseUrl 等配置；检查继承的 `HOST`、`PORT`、`DEVSPACE_ALLOWED_ROOTS` 等环境变量是否与项目配置冲突。

## 配置与开关

先在一个已有的、无秘密的项目目录测试本地模式：

```powershell
powershell.exe -NoProfile -File $controller -Action Configure -ProjectRoot 'C:\projects\demo' -AllowedRoots 'C:\projects\demo' -Tunnel none -Port 7676
powershell.exe -NoProfile -File $controller -Action On
powershell.exe -NoProfile -File $controller -Action Doctor
powershell.exe -NoProfile -File $controller -Action Off
```

ChatGPT 远程访问需要可用的公共 HTTPS。推荐先准备你自己管理的稳定通道，转发到 `http://127.0.0.1:7676`，然后配置 external 模式：

```powershell
powershell.exe -NoProfile -File $controller -Action Configure -ProjectRoot 'C:\projects\demo' -AllowedRoots 'C:\projects\demo' -Tunnel external -Port 7676 -PublicBaseUrl 'https://bridge.example.invalid'
powershell.exe -NoProfile -File $controller -Action On
powershell.exe -NoProfile -File $controller -Action Status
powershell.exe -NoProfile -File $controller -Action Reboot
powershell.exe -NoProfile -File $controller -Action Off
```

用你的实际 HTTPS URL 替换示例。`Reboot` 是一次经过检查的 `Restart`；主动 `Off` 后它拒绝重新开启，需先执行 `On`。`Off` 关闭本地服务和隧道，保留配置及客户端连接材料。`Doctor` 检查 OAuth metadata 返回200、未授权 `/mcp` 返回401；实际可用性还需完成授权后的 MCP 工具调用。

`cloudflare` 模式使用临时 Quick Tunnel，需 `-InstallCloudflared` 或先准备脚本状态目录里的 `bin/cloudflared.exe`；脚本校验 Cloudflare Authenticode 签名。Quick Tunnel 域名变化且 [不支持 SSE](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)，请验证所用 MCP 客户端的传输是否适配。

可选 `cloudflare-worker` 模式要求已单独部署好稳定 Worker 和绑定 KV。先 Configure 指定该模式及稳定 PublicBaseUrl，再用 `set_cf_api_config.ps1 -Action Set -AccountId '<32-hex-id>' -KvNamespaceId '<32-hex-id>'` 在隐藏提示中输入 Workers KV Storage: Edit token，最后 On；脚本更新 KV 的 `current` 指针，本仓库不创建 Worker。DPAPI 保护静态凭据，但不会隔离以同一 Windows 用户运行的已授权 shell。

如需按需恢复入口，执行 `restart_task.ps1 -Action Install` 创建同用户、无自动触发器的任务；`-Action Run` 是异步请求，检查新的 controller-result.json 与 Doctor 后再判断结果。

## 连接 ChatGPT 与协作

按 [官方连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt) 启用 Developer mode，添加 `https://你的公共入口/mcp`，使用 [OAuth](https://developers.openai.com/plugins/build/auth)。在本地授权表单填写自己的 Owner password，不把它贴到聊天或仓库。先试一次只读项目访问。

Chrome 承载消息，MCP 承载工具请求；本项目不会自动发送或取回 ChatGPT 消息。可以手动粘贴任务与回复，或使用你的浏览器自动化工具。把仓库的 [SKILL.md](SKILL.md) 安装为 Codex skill 时，将此目录放入 `$HOME\.codex\skills\codex-chatgpt-bridge`，保留 `scripts/` 与 skill 的相对位置。

任务示例：

```text
Task ID: demo-review-001
Goal: 阅读项目 README，提出一个可由 Codex 本地验证的改进。
Workspace: C:\projects\demo
Permission: 只读策略；禁止 shell、写入、秘密读取和 git 推送。
Tool budget: 最多3次；重复失败立即停止并说明缺失证据。
Output: Action Manifest：结论、证据、建议修改、验证命令。
```

Codex 接收 Manifest 后核对证据，执行授权范围内的修改与测试，再返回结果。权限等级是协作策略；已授权 shell 使用服务运行账户的权限，文件根目录限制不能约束任意 shell 命令。用完执行 Off。

## Windows 发起 SSH 任务

也可以让 Windows Codex，或明确授权的 bridge `run_shell`，调用已配置的 SSH：

```text
ChatGPT → Windows DevSpace run_shell → ssh gpu-server → GPU服务器命令
```

```bash
ssh gpu-server 'nvidia-smi'
```

`gpu-server` 是你在 SSH config 中定义的通用 Host 示例；连接与认证由操作者配置。SSH 不自动把 Linux 路径变成 Windows MCP 文件根目录。远端训练、长任务与结果核验可由 Codex 接管，再把摘要交回 ChatGPT。

## 许可

本仓库代码与使用说明采用 [MIT](LICENSE)。DevSpace 是独立上游依赖，其接入 patch 保留 [第三方许可通知](THIRD_PARTY_NOTICES.md)。`ws` 从 lockfile 独立安装。Codex、Node、OpenSSH、cloudflared 等组件由操作者另行安装并遵守各自许可。
