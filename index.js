/**
 * dsh-cloud-sync — move a DSH profile's plugins and settings between machines
 * through one file in a GitHub repository.
 *
 * Nothing here touches conversations, workspace state, caches or credentials:
 * the snapshot is the profile manifest, its patch layer, the pnpm inputs and
 * patch files, plus the home-level patch layer.
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  PLUGIN_NAME,
  applySnapshot,
  collectSnapshot,
  contentDigest,
  decodeSnapshot,
  deviceName,
  downloadSnapshot,
  findPnpm,
  githubList,
  githubRead,
  mergeSnapshots,
  resolvePaths,
  runPnpmInstall,
  uploadBackup,
  uploadSnapshot,
} from './lib/core.js'

const USAGE = [
  '用法：/sync [status|push|pull|restore]',
  '  /sync         双向同步（默认）：合并云端与本机，保留本机独有插件，先备份再覆盖',
  '  /sync push    只上传本机配置',
  '  /sync pull    同 /sync（拉取并合并）',
  '  /sync restore 回到最近一次同步前的状态',
  '  /sync status  查看配置与云端快照',
].join('\n')

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

export const inject = ['commands', 'tools']

export const Config = z.object({
  repo: z.string().default('').volatile().description('快照仓库，格式 owner/name；建议私有仓库。'),
  branch: z.string().default('main').volatile().description('快照所在分支。'),
  path: z.string().default('dsh-sync/snapshot.json.gz').volatile().description('快照文件在仓库中的路径。'),
  token: z.string().default('').volatile().description('GitHub PAT（contents 读写权限）。也可用环境变量 DSH_SYNC_GITHUB_TOKEN。'),
})

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1048576).toFixed(1)} MiB`
}

function tail(text, limit = 1200) {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

function createSync(config) {
  const settings = () => {
    const envToken = process.env.DSH_SYNC_GITHUB_TOKEN
    const configured = config.token.get()
    return {
      repo: config.repo.get().trim(),
      branch: config.branch.get().trim() || 'main',
      path: config.path.get().trim() || 'dsh-sync/snapshot.json.gz',
      token: (typeof configured === 'string' && configured.trim().length > 0
        ? configured.trim()
        : (typeof envToken === 'string' ? envToken.trim() : '')),
    }
  }

  const request = () => {
    const current = settings()
    if (!current.repo) return { error: '还没有配置快照仓库。请在 设置 → 插件 → 云同步 里填写 repo（owner/name）。' }
    if (!REPO_PATTERN.test(current.repo)) return { error: `仓库格式不对：${current.repo}。应为 owner/name。` }
    if (!current.token) return { error: '还没有配置 GitHub Token。请在插件设置里填写，或设置环境变量 DSH_SYNC_GITHUB_TOKEN。' }
    return current
  }

  async function status() {
    const paths = resolvePaths()
    const current = settings()
    const lines = ['云同步状态', `profile：${paths.profileDir}`, `设备：${deviceName()}`]

    let bundles = []
    let dependencies = []
    try {
      const snapshot = await collectSnapshot(paths)
      bundles = snapshot.bundles
      dependencies = snapshot.dependencies
    } catch (error) {
      lines.push(`读取本机配置失败：${error.message}`)
    }
    lines.push(`本机插件：${bundles.length} 个 bundle，${dependencies.length} 个依赖`)

    if (!current.repo || !current.token) {
      if (current.repo) {
        lines.push(`仓库：${current.repo}@${current.branch}`)
        lines.push('云端：缺 token。请在 设置 → 插件 → 云同步 的配置里粘贴 PAT。')
      } else {
        lines.push('云端：未配置仓库')
        lines.push('在 设置 → 插件 → 云同步 中填写 repo 与 token 后，点输入框旁的「云同步」按钮。')
      }
      return { ok: false, text: lines.join('\n') }
    }

    lines.push(`仓库：${current.repo}@${current.branch} → ${current.path}`)
    try {
      const remote = await downloadSnapshot({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: current.path,
      })
      if (!remote) {
        lines.push('云端：仓库可访问，但还没有快照。运行 /sync 会先把本机上传。')
        return { ok: true, text: lines.join('\n') }
      }
      const local = await collectSnapshot(paths)
      lines.push(`云端快照：${formatBytes(remote.bytes)}，导出 ${remote.snapshot.createdAt}`)
      lines.push(`来源设备：${remote.snapshot.source?.device ?? remote.snapshot.source?.mergedBy?.device ?? '?'}`)
      lines.push(`云端插件：${(remote.snapshot.bundles ?? []).length} 个 bundle，${(remote.snapshot.dependencies ?? []).length} 个依赖`)
      lines.push(contentDigest(local) === contentDigest(remote.snapshot)
        ? '结论：两边内容一致，无需同步。'
        : '结论：有差异，运行 /sync 合并。')
      return { ok: true, text: lines.join('\n') }
    } catch (error) {
      lines.push(`云端：访问失败 — ${error.message}`)
      return { ok: false, text: lines.join('\n') }
    }
  }

  async function push() {
    const current = request()
    if (current.error) return { ok: false, text: current.error }
    const paths = resolvePaths()
    try {
      const snapshot = await collectSnapshot(paths)
      const result = await uploadSnapshot({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: current.path,
        snapshot,
        message: `cloud-sync: ${snapshot.bundles.length} bundles from ${deviceName()}`,
      })
      return {
        ok: true,
        text: [
          '已上传本机配置',
          `仓库：${current.repo}@${current.branch}`,
          `文件：${current.path}（${formatBytes(result.bytes)}，${result.created ? '新建' : '更新'}）`,
          `内容：${snapshot.bundles.length} 个 bundle，${snapshot.dependencies.length} 个依赖`,
          `提交：${result.sha.slice(0, 7)}`,
          '',
          '不含对话、工作区、任务、缓存与凭据。',
        ].join('\n'),
      }
    } catch (error) {
      return { ok: false, text: `上传失败：${error.message}` }
    }
  }

  /**
   * Two-way sync: fetch the remote snapshot, archive this machine's current
   * state (locally and under `backups/`), merge, install, then publish the
   * merged result so both machines converge.
   */
  async function sync() {
    const current = request()
    if (current.error) return { ok: false, text: current.error }
    const paths = resolvePaths()

    let local
    try {
      local = await collectSnapshot(paths)
    } catch (error) {
      return { ok: false, text: `读取本机配置失败：${error.message}` }
    }

    let remote
    try {
      remote = await downloadSnapshot({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: current.path,
      })
    } catch (error) {
      return { ok: false, text: `读取云端快照失败：${error.message}` }
    }

    if (!remote) {
      const uploaded = await push()
      return uploaded.ok
        ? { ok: true, text: `云端还没有快照，已把本机配置作为初始版本上传。\n\n${uploaded.text}` }
        : uploaded
    }

    if (contentDigest(local) === contentDigest(remote.snapshot)) {
      return {
        ok: true,
        text: [
          '两边已经一致，无需同步。',
          `快照时间：${remote.snapshot.createdAt}`,
          `插件：${(remote.snapshot.bundles ?? []).length} 个 bundle`,
        ].join('\n'),
      }
    }

    let backupPath
    try {
      backupPath = await uploadBackup({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        snapshot: local,
      })
    } catch (error) {
      return { ok: false, text: `上传同步前备份失败，已停止以免丢配置：${error.message}` }
    }

    const { snapshot: merged, stats } = mergeSnapshots(local, remote.snapshot)

    let applied
    try {
      applied = await applySnapshot(merged, paths)
    } catch (error) {
      return { ok: false, text: `写入合并结果失败：${error.message}\n同步前快照：${backupPath}` }
    }

    const lines = [
      '双向同步完成',
      `合并：云端 ${(remote.snapshot.bundles ?? []).length} + 本机独有 ${stats.addedBundles.length} 个 bundle`,
      `保留本机独有：${stats.addedBundles.length > 0 ? stats.addedBundles.join(', ') : '无'}`,
    ]
    if (stats.keptLocalOnlyFiles.length > 0) {
      lines.push(`保留本机独有文件：${stats.keptLocalOnlyFiles.join(', ')}`)
    }
    lines.push(`同步前快照：${backupPath}（仓库 backups/ 下，可随时取回）`)
    lines.push(`本机备份：${applied.backupDir}`)

    const installer = findPnpm()
    if (!installer) {
      lines.push('', '没找到应用自带的 pnpm，依赖未安装。请在 DeepSeek Harness 终端里执行：dsh plugin install')
      return { ok: false, text: lines.join('\n') }
    }

    lines.push('', '正在安装插件依赖（可能需要几分钟）…')
    const install = await runPnpmInstall(installer, paths.profileDir)
    if (!install.ok) {
      lines.push(`依赖安装失败（退出码 ${install.code ?? '?'}）：`)
      lines.push(tail(install.output))
      lines.push('', '可在 DeepSeek Harness 终端里重试：dsh plugin install')
      lines.push('合并结果已写入本机；云端未更新，修好后再次运行 /sync 即可。')
      return { ok: false, text: lines.join('\n') }
    }
    lines.push('依赖安装完成。')

    try {
      const after = await collectSnapshot(paths)
      const uploaded = await uploadSnapshot({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: current.path,
        snapshot: after,
        message: `cloud-sync: merged ${after.bundles.length} bundles from ${deviceName()}`,
      })
      lines.push(`已把合并结果推回云端（${uploaded.sha.slice(0, 7)}），另一台直接 /sync 即可。`)
    } catch (error) {
      lines.push(`合并结果写回云端失败：${error.message}（本机已生效，可稍后 /sync push）`)
    }

    lines.push('', '请完全退出并重新打开 DeepSeek Harness，让新插件与设置生效。')
    return { ok: true, text: lines.join('\n') }
  }

  /** Re-apply the newest archived pre-sync snapshot. */
  async function restore() {
    const current = request()
    if (current.error) return { ok: false, text: current.error }
    const paths = resolvePaths()

    let entries
    try {
      entries = await githubList({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: 'backups',
      })
    } catch (error) {
      return { ok: false, text: `读取备份目录失败：${error.message}` }
    }
    const candidates = entries
      .filter((entry) => entry.name.endsWith('.json.gz'))
      .sort((left, right) => (left.name < right.name ? 1 : -1))
    if (candidates.length === 0) {
      return { ok: false, text: '云端还没有同步前备份。第一次 /sync 时会自动创建。' }
    }

    const latest = candidates[0]
    let file
    try {
      file = await githubRead({
        token: current.token,
        repo: current.repo,
        branch: current.branch,
        path: latest.path,
      })
    } catch (error) {
      return { ok: false, text: `下载备份失败：${error.message}` }
    }
    if (!file) return { ok: false, text: `备份不存在：${latest.path}` }

    let snapshot
    try {
      snapshot = decodeSnapshot(file.content)
    } catch (error) {
      return { ok: false, text: `备份损坏：${error.message}` }
    }

    let applied
    try {
      applied = await applySnapshot(snapshot, paths)
    } catch (error) {
      return { ok: false, text: `恢复失败：${error.message}` }
    }

    const lines = [
      '已恢复同步前的状态',
      `备份：${latest.name}`,
      `来源设备：${snapshot.source?.device ?? '?'}`,
      `写入：${applied.written} 个文件，当前状态另存于 ${applied.backupDir}`,
    ]

    const installer = findPnpm()
    if (!installer) {
      lines.push('', '没找到应用自带的 pnpm，请在终端执行：dsh plugin install')
      return { ok: false, text: lines.join('\n') }
    }
    const install = await runPnpmInstall(installer, paths.profileDir)
    lines.push(install.ok ? '依赖安装完成。' : `依赖安装失败，请手动执行 dsh plugin install。\n${tail(install.output)}`)
    lines.push('', '请完全退出并重新打开 DeepSeek Harness。')
    lines.push('提示：恢复只影响本机，不会改动云端；如需以当前状态覆盖云端，运行 /sync push。')
    return { ok: install.ok, text: lines.join('\n') }
  }

  async function run(rawInput) {
    const action = rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    let result
    if (action === '' || action === 'status') result = await status()
    else if (action === 'push' || action === 'upload') result = await push()
    else if (action === 'pull' || action === 'sync') result = await sync()
    else if (action === 'restore' || action === 'undo') result = await restore()
    else if (action === 'help') result = { ok: true, text: USAGE }
    else result = { ok: false, text: `未知子命令：${action}\n${USAGE}` }
    return { kind: result.ok ? 'success' : 'error', text: result.text }
  }

  return { status, push, sync, run }
}

export function apply(ctx, config) {
  const sync = createSync(config)
  for (const [name, description] of [
    ['sync', '双向同步插件与应用设置（合并 + 备份）'],
    ['cloud-sync', '双向同步插件与应用设置（/sync 的旧名字）'],
  ]) {
    ctx.effect(() => ctx.commands.register({
      definitionId: `dsh-cloud-sync:${name}`,
      name,
      description,
      input: { hint: '[status|push|pull]' },
      handler: (invocation) => sync.run(invocation.rawInput),
    }))
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cloud_sync',
    description: 'Inspect or upload this profile\'s plugins and settings through the GitHub cloud-sync repository. Two-way merging (`/sync`) is user-only: it reinstalls dependencies and asks for a restart.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'push'],
        description: 'status reports configuration and the remote snapshot; push uploads the current profile.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      const result = args.action === 'push' ? await sync.push() : await sync.status()
      return result.text
    },
  })))
}

export const name = PLUGIN_NAME
