# dsh-cloud-sync

通过一个 **GitHub 仓库**，在多台电脑之间同步 DeepSeek Harness 的插件与应用设置。

**两个方向分开操作，不做自动合并**——避免一台机器上的微调被另一台悄悄覆盖。

- **以云端更新本机**：用云端快照替换本机插件与设置，覆盖前自动备份，不改云端。
- **以本机覆盖云端**：把本机当前状态推上去，云端以这台为准。

## 面板

输入框工具行的 **「云同步」** 按钮展开面板：

```text
┌ 云同步                                        × ┐
│ 两个方向分开操作，不做自动合并……                │
│ 仓库 Perfactiona/htc_DSHsetups   分支 main      │
│ 快照路径 dsh-sync/snapshot.json.gz               │
│ Token  已保存（留空则不修改）                    │
│ [保存配置]                                       │
│ [以云端更新本机] [以本机覆盖云端]                │
│ [查看状态] [恢复上次]                            │
│ <执行结果>                                       │
└─────────────────────────────────────────────────┘
```

| 按钮 | 命令 | 行为 |
|---|---|---|
| 以云端更新本机 | `/sync pull` | 下载 → 备份本机到云端 `backups/` 和本地 → 覆盖本机 → 重装依赖 |
| 以本机覆盖云端 | `/sync push` | 把本机快照写到仓库的 `dsh-sync/snapshot.json.gz` |
| 查看状态 | `/sync status` | 配置、云端快照时间、两边是否一致 |
| 恢复上次 | `/sync restore` | 把最近一份 `backups/` 应用到本机（只改本机） |

两者都会先备份；`pull` 在云端没有快照时不会自动上传，而是提示先在有配置的那台执行 `push`。

## 快照里有什么

| 内容 | 同步 |
|---|---|
| `profiles/<profile>/package.json`（bundle 清单 + 依赖版本） | ✅ |
| `profiles/<profile>/cordis.patch.yml`（主题、模型、插件配置、启用/禁用） | ✅ |
| `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`patches/`、`compatibility.json` | ✅ |
| `$DSH_HOME/cordis.patch.yml` | ✅ |
| `$DSH_HOME/plugins/**`（自己写的插件源码，文本文件） | ✅ |
| `node_modules` | ❌ 到目标机重装 |
| 对话、工作区、任务、缓存 | ❌ |
| `.credentials.yaml`（登录令牌 / API Key） | ❌ |

`pull` 覆盖 `package.json` 时会保留本机安装 `dsh-cloud-sync` 自己的那条依赖和 bundle 行，避免把同步插件自己删掉。

### 本地插件源码

`plugins/` 下的东西在 profile 之外，只同步清单是搬不动的，所以整棵树按文本文件放进快照：跳过 `node_modules`、`.git`、`dist`、`__pycache__` 等目录，也跳过图片等二进制（它们过不了 utf8 快照）。

`pull` 时：

- 源码写回目标机的 `$DSH_HOME/plugins/`，写之前先把本机现有那棵树备份进 `cloud-sync-backup-<时间戳>/plugins/`；
- `package.json` 里指向 `plugins/<包名>` 的 `link:` / `file:` 依赖会被**重写到目标机的实际路径**——快照里存的是推送那台机器的路径，直接用会指向不存在的目录；
- 之后照常 `pnpm install`，链接安装随之生效。

快照体积随之上升（本项目 39 个文件、gzip 后约 68 KB），仍在 4 MiB 上限内。

## 配置

在面板里填写，保存后写入本 profile 的 `cordis.patch.yml`：

| 字段 | 说明 |
|---|---|
| `repo` | 快照仓库 `owner/name`，建议私有仓库 |
| `branch` | 默认 `main` |
| `path` | 仓库内路径，默认 `dsh-sync/snapshot.json.gz`，两台必须一致 |
| `token` | 细粒度 PAT，只给该仓库 `Contents: Read and write`；以 secret 角色存储，读取时脱敏 |

Token 也可用环境变量 `DSH_SYNC_GITHUB_TOKEN`。

## 安装

```powershell
# DeepSeek Harness 终端
dsh plugin add https://github.com/Perfactiona/DSH_sync/archive/refs/heads/main.tar.gz
```

或让 DSH 里的助手用插件管理器安装该 tarball。装完重启应用。

## 仓库

| 仓库 | 用途 | 建议 |
|---|---|---|
| `Perfactiona/DSH_sync` | 插件代码 | public，另一台免认证安装 |
| `Perfactiona/htc_DSHsetups` | 快照与备份 | private，插件用 PAT 访问 |

## 发布

本机没有 git，用脚本走 GitHub API（一次提交）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-github.ps1 `
  -Token <临时PAT> -Repo Perfactiona/DSH_sync -Public
```

发布后到 https://github.com/settings/personal-access-tokens 把临时 PAT 删除。

## 限制

- **版本一致性**：插件按精确版本安装并校验运行时版本；两台差太多会被跳过并提示 incompatible。
- **本机 `link:` 插件**：0.5.0 起 `plugins/` 下的源码会随快照一起走，`pull` 会写回并把 `link:` 重写到目标机路径，不再需要手动重装；指向 `plugins/` 之外的 `link:` 仍会失效。
- **不做三方合并**：同一项设置两边都改过时，后执行的方向获胜；旧状态在 `backups/` 里。
- **恢复失败**：桌面版会把 `cordis.patch.yml` 改名并停用第三方 bundle；也可手动回拷 `cloud-sync-backup-<时间戳>/` 后执行 `dsh plugin install`。

## 已验证

- Desktop 0.2.1-rc.3：插件挂载、配置命名空间读写、`cloud_sync status` 实跑通过。
- 快照收集/写入、空仓库首次写入、路径越界防护：`dev/test-core.mjs` 单测通过。
- 面板渲染与按钮交互需在浏览器中确认。

## 增量上传

快照不再是一个大 gz，而是按文件存放，push 只传变化的部分：

```
dsh-sync/state.json          ← 索引：每个文件的 sha256、导出时间、bundle 清单
dsh-sync/files/<路径>         ← 一个文件一个对象，内容就是快照里的原文
```

- push 时先读云端索引，逐个比对 sha256，**只上传内容变了的文件**；没变的一个字节都不发；
- 索引最后写，所以中途失败不会留下"索引指向不存在的文件"的状态；
- pull 时按索引逐个下载，并校验每个文件的 sha256 与索引一致，不一致立即中止；
- 仓库里因此保留的是「每次变化的历史对象」，相同内容只存一份。

配置里的 `path`（默认 `dsh-sync/snapshot.json.gz`）现在只用来决定**目录**：`dsh-sync/`。索引固定叫 `state.json`，文件在 `files/` 下。

体积上限：单文件仍受 GitHub 的 100 MB 限制，但不再有「整份快照必须 < 4 MiB」的约束；本地备份（`backups/` 里的整包 gz）上限放宽到 64 MiB。

> 0.6.0 起的格式与旧的单文件快照不兼容：旧仓库首次 push 会重建 `state.json` 与 `files/`，另一台必须同版本才认。

## License

MIT
