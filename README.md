# dsh-cloud-sync

用**一个 GitHub 仓库**在几台电脑之间**双向**同步 DeepSeek Harness 的插件与应用设置。

- 输入框工具行多一个 **「云同步」按钮**，点一下即可。
- 也可以输入 `/sync`（或旧名字 `/cloud-sync`）。
- 同步前自动把本机状态备份到云端 `backups/` 和本地，随时可退回。

## 一键怎么用

输入框工具行的 **「云同步」** 按钮会展开一个面板：

```text
┌ 云同步                                    × ┐
│ 双向同步两台电脑的插件与设置：合并插件列表、  │
│ 设置以云端为准，覆盖前自动备份……            │
│ [双向同步] [上传本机] [查看状态] [恢复上次] │
│ 首次使用先到 设置 → 插件 填 repo 与 token    │
│ <执行结果>                                  │
└─────────────────────────────────────────────┘
```

| 面板按钮 | 等价命令 |
|---|---|
| 双向同步 | `/sync` |
| 上传本机 | `/sync push` |
| 查看状态 | `/sync status` |
| 恢复上次 | `/sync restore` |

第一次点按钮：如果云端还没有快照，会把本机配置作为初始版本上传；如果云端已有，则合并两边并推回。面板里的结果同时也会在对话中留下一条命令记录。

## 双向合并规则（不丢东西）

以云端快照为底，本机独有内容保留：

| 内容 | 规则 |
|---|---|
| 插件 bundle 列表 | **并集**：云端顺序 + 本机独有追加 |
| 仅本机有的依赖 | 保留 |
| 本机用 `link:` / `file:` 安装的依赖 | **保留本机写法**，不会被别的机器的路径覆盖 |
| 其他依赖版本 | 以云端为准（这样一台机器升级，另一台能收到） |
| `cordis.patch.yml` 设置、锁文件、补丁 | 以云端为准 |
| 云端没有的本机补丁文件 | 保留 |
| 全局 `$DSH_HOME/cordis.patch.yml` | 云端有则用云端，否则保留本机 |

覆盖之前一定先备份：

1. 云端 `backups/<时间戳>-<设备名>.json.gz`（同步前状态，`/sync restore` 取最近一份）
2. 本地 `~/.dsh/cloud-sync-backup-<时间戳>/`
3. 每次推送都是一个 git 提交，历史可查

`/sync restore` 只改本机、不动云端；想以恢复后的状态覆盖云端，再执行 `/sync push`。

## 同步什么

| 内容 | 同步 |
|---|---|
| `profiles/<profile>/package.json` | ✅ |
| `profiles/<profile>/cordis.patch.yml`（设置、启用/禁用） | ✅ |
| `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`compatibility.json` | ✅ |
| `$DSH_HOME/cordis.patch.yml` | ✅ |
| `node_modules` | ❌ 到新机重装 |
| 对话、工作区、任务、缓存 | ❌ |
| `.credentials.yaml`（账号令牌 / API Key） | ❌ |

## 两个仓库怎么填

| 仓库 | 用途 | 建议 | 现在 |
|---|---|---|---|
| `Perfactiona/DSH_sync` | **代码**：插件本体，另一台从这里安装 | public | 已存在、空仓库 |
| `Perfactiona/htc_DSHsetups` | **快照**：插件运行时写入 `dsh-sync/snapshot.json.gz` 和 `backups/` | private | 需存在（私有空仓库即可） |

插件配置（设置 → 插件 → `dsh-cloud-sync`）：

```text
repo   = Perfactiona/htc_DSHsetups
branch = main
path   = dsh-sync/snapshot.json.gz
token  = 对 htc_DSHsetups 有 Contents 读写的细粒度 PAT
```

Token 只用于快照仓库；代码仓库是公开的，安装不需要 Token。

## 安装

### 另一台电脑（从 GitHub 装）

```powershell
# DeepSeek Harness 终端
dsh plugin add https://github.com/Perfactiona/DSH_sync/archive/refs/heads/main.tar.gz
```

装完重启应用，输入框工具行就会出现「云同步」按钮。

### 本机（开发目录）

```powershell
dsh plugin add C:\Users\11206\OneDrive\文档\deepseek-harness\default-workspace\dsh-cloud-sync
```

## 发布到 GitHub

这台机器没有 git，用自带脚本走 API 发布（一个提交写完所有文件）：

```powershell
cd dsh-cloud-sync
powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-github.ps1 `
  -Token ghp_xxxxxxxx -Repo Perfactiona/DSH_sync -Public
```

脚本会复用已存在的空仓库，只在 `main` 上创建一个提交。发布后在另一台执行上面的安装命令。

## 限制与恢复

- **版本一致性**：插件按精确版本安装并校验 DSH 运行时版本；两台差太多时会被跳过并提示 incompatible，先升级。
- **本机 `link:` 插件**：本机会保留自己的 `link:` 写法；把它合并推给别的机器后，别的机器如果没有同样目录，安装会失败。建议只在本机使用 `link:` 开发插件。
- **恢复失败**：配置已写入但启动异常时，桌面版会把 `cordis.patch.yml` 改名并停用第三方 bundle；也可以手动把 `cloud-sync-backup-<时间戳>/` 拷回 profile，再执行 `dsh plugin install`。
- **按钮出现位置**：输入框左侧工具行（`conversation.input.left`）。若升级后没看到，刷新页面或重启应用。

## 已验证范围

- Desktop 0.2.1-rc.3：插件挂载、配置 schema、`cloud_sync status` 实跑通过（本机设备名 `BigHuangDesk-win32`）。
- 合并、摘要比对、快照收集/写入、空仓库首次写入、路径越界防护：`dev/test-core.mjs` 单测通过。
- 客户端按钮已注册到 `conversation.input.left`，但页面渲染效果需要在浏览器刷新后确认（本机无法代看）。
- 真实 GitHub 往返需要你的 PAT，未代跑。

## License

MIT
