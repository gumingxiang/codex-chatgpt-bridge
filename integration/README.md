# DevSpace 1.0.8 接入

此 patch 针对公开 npm 包 `@waishnav/devspace@1.0.8` 的 `dist/server.js`。包的 `gitHead` 对应上游 [固定提交 fe712e2](https://github.com/Waishnav/devspace/tree/fe712e2b6c07231d2a76503bf2a674b165850616)。三个插入点是扩展 import、在 workspace 工具注册前 attach、服务关闭时 close。原服务器仍由 DevSpace 维护；升级 DevSpace 前重新核对 patch 和其依赖。

以下是操作者执行的示例命令，不自动迁移或重启任何现有实例。选择独立部署目录，保持布局：

```text
codex-chatgpt-bridge/
  bridge/                   本仓库扩展
  node_modules/ws/          本仓库 lockfile 安装
  runtime/                  独立安装、忽略提交的 DevSpace 1.0.8
    dist/cli.js
    dist/server.js
    node_modules/           DevSpace 自身依赖
  integration/
```

Linux 从仓库根执行，先检查代理环境与 npm proxy 配置。默认直连；只在确需代理时给必要子进程局部设置。

```bash
npm ci --ignore-scripts
mkdir -p runtime
npm pack @waishnav/devspace@1.0.8 --ignore-scripts
sha256sum waishnav-devspace-1.0.8.tgz
tar -xzf waishnav-devspace-1.0.8.tgz -C runtime --strip-components=1
npm --prefix runtime install --omit=dev
git apply --check integration/devspace-1.0.8.patch
git apply integration/devspace-1.0.8.patch
node --check runtime/dist/server.js
npm test
node integration/smoke.mjs "$PWD/runtime/package.json"
```

公开 tarball 本次核验的 SHA256 为 `59578f71855c160826682fa0409ca885287fee79f549b57128d8962348ff6488`；核对成功后再解包。也可直接通过 registry 的 integrity 信息核验。依赖需在实际 Node 版本下正常安装；DevSpace `serve` 会检查 better-sqlite3 原生 binding，失败时按其诊断在独立 runtime 中重建依赖。不要复用另一平台的 binding 或私人 runtime 文件。

三处 patch 应全部应用；从仓库根执行 `git apply --reverse --check integration/devspace-1.0.8.patch` 可核对已应用状态。本次审查另在仓库之外的独立公开解包目录运行 `git apply -p2` 和逆向检查，保留原始 runtime 的独立性。不要用忽略冲突或覆盖整份 server 的办法。

先按 [运维说明](../docs/gpu-operations.md) 放置非秘密配置和明确模型策略。新的独立实例需要 `DEVSPACE_CONFIG_DIR` 指向部署配置目录，再运行该 runtime 的 `node runtime/dist/cli.js init` 配置 Owner password；不要对已有实例重跑 init 或轮换授权。启动入口是 `node runtime/dist/cli.js serve`，不是直接运行仅导出服务器函数的 server.js。

`smoke.mjs` 使用传入的独立 DevSpace 安装中的真实 MCP SDK/zod，加载 candidate extension，注册六个工具并通过实际 SDK 的 InMemoryTransport 调用 list/read/models。RPC 使用离线 fixture，验证项目过滤和越界拒绝，不启动 HTTP、OAuth 或模型任务。公开原始服务器的 patch apply/syntax 是独立检查；本 smoke 不宣称完整 OAuth/HTTP 服务已验收。部署后还需 metadata、未授权 `/mcp`、授权只读文件和任务访问的实际验收。

保留 runtime 自带 LICENSE，以及本仓库 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。完整 runtime、node_modules、DB、auth、日志、桌面 context 和备份都不提交。
