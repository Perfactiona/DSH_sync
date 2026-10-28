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
| `node_modules` | ❌ 到目标机重装 |
| 对话、工作区、任务、缓存 | ❌ |
| `.credentials.yaml`（登录令牌 / API Key） | ❌ |

`pull` 覆盖 `package.json` 时会保留本机安装 `dsh-cloud-sync` 自己的那条依赖和 bundle 行，避免把同步插件自己删掉。

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
- **本机 `link:` 插件**：`pull` 覆盖清单后，本机被链接的插件会消失，需要重新安装。
- **不做三方合并**：同一项设置两边都改过时，后执行的方向获胜；旧状态在 `backups/` 里。
- **恢复失败**：桌面版会把 `cordis.patch.yml` 改名并停用第三方 bundle；也可手动回拷 `cloud-sync-backup-<时间戳>/` 后执行 `dsh plugin install`。

## 已验证

- Desktop 0.2.1-rc.3：插件挂载、配置命名空间读写、`cloud_sync status` 实跑通过。
- 快照收集/写入、空仓库首次写入、路径越界防护：`dev/test-core.mjs` 单测通过。
- 面板渲染与按钮交互需在浏览器中确认。

## License

MIT
