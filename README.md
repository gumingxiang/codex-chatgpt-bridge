# Codex ChatGPT Bridge

让 Codex 负责本地执行与验证，让 ChatGPT 负责推理与评审；通过 DevSpace MCP 访问项目，通过 Chrome 手动传递消息或配合已启用的浏览器自动化工具完成任务往返。

```text
Codex ↔ Chrome 中的 ChatGPT：Task Packet / Action Manifest
ChatGPT → HTTPS + OAuth + MCP → DevSpace → 文件与 shell 工具
```

四个 PowerShell 脚本提供 **Windows** 生命周期管理。上游 [DevSpace 支持 Linux](https://github.com/Waishnav/devspace/tree/v1.0.8#platform-support)，可以直接部署在 Linux 服务器；本仓库不提供 Linux 控制脚本、Worker 部署程序或 Chrome 消息驱动。

## 安装

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

## Linux 服务器与 GPU

可以直接在 Linux 上安装 DevSpace、运行 `devspace init` 配好项目根与公共 HTTPS，然后启动通道并运行 `devspace serve`；需要 Node/npm/Git/Bash，进程管理由你自己的 Linux 运维方式承担。ChatGPT 此时直接通过 MCP 访问 Linux 项目。

也可以让 Windows Codex，或明确授权的 bridge `run_shell`，调用已配置的 SSH：

```text
ChatGPT → Windows DevSpace run_shell → ssh gpu-server → GPU服务器命令
```

```bash
ssh gpu-server 'nvidia-smi'
```

`gpu-server` 是你在 SSH config 中定义的通用 Host 示例；连接与认证由操作者配置。SSH 不自动把 Linux 路径变成 Windows MCP 文件根目录。远端训练、长任务与结果核验可由 Codex 接管，再把摘要交回 ChatGPT。

## 许可

本仓库代码与使用说明采用 [MIT](LICENSE)。DevSpace 是独立上游依赖，见 [上游 MIT 许可证](https://github.com/Waishnav/devspace/blob/v1.0.8/LICENSE)；不随本仓库分发。cloudflared 等组件由操作者另行安装并遵守各自许可。
