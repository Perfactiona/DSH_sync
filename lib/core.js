/**
 * Filesystem and GitHub plumbing for dsh-cloud-sync.
 *
 * Deliberately free of Cordis imports so it can be exercised with plain Node.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

export const SNAPSHOT_SCHEMA = 1
export const PLUGIN_NAME = 'dsh-cloud-sync'
export const SNAPSHOT_FILES = [
  'package.json',
  'cordis.patch.yml',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'compatibility.json',
]
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024

/**
 * Every plugin this machine owns as source lives under `<DSH_HOME>/plugins`,
 * outside the profile, so a manifest-only snapshot cannot restore it. The whole
 * tree rides along inside the snapshot under this prefix and is written back on
 * pull; third-party plugins stay ordinary registry/git dependencies.
 */
export const PLUGIN_TREE = 'plugins'
/** Directory names never walked inside the plugin tree. */
const TREE_IGNORE = new Set(['node_modules', '.git', '__pycache__', 'dist', '.cache', '.venv'])
/** Only text files are carried; a binary would not survive the utf8 snapshot. */
const TREE_TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt',
  '.svg', '.css', '.html', '.ps1', '.py', '.toml',
])

function assertSafeRelative(relative) {
  if (typeof relative !== 'string' || relative.length === 0) throw new Error('empty snapshot path')
  if (relative.startsWith('/') || relative.startsWith('\\') || /^[a-zA-Z]:/.test(relative)) {
    throw new Error(`absolute snapshot path is not allowed: ${relative}`)
  }
  if (relative.split(/[\\/]/).includes('..')) throw new Error(`snapshot path escapes the profile: ${relative}`)
}

/**
 * Resolve the harness home and the active profile directory.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{home: string, profile: string, profileDir: string}}
 */
export function resolvePaths(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? resolve(env.DSH_HOME) : join(homedir(), '.dsh')
  const profile = env.DSH_PROFILE && env.DSH_PROFILE.trim() ? env.DSH_PROFILE : 'desktop'
  const profileDir = env.DSH_PROFILE_DIR && env.DSH_PROFILE_DIR.trim()
    ? resolve(env.DSH_PROFILE_DIR)
    : join(home, 'profiles', profile)
  return { home, profile, profileDir }
}

async function readIfPresent(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Read every text file under one directory as `relative/path → content`.
 * Missing directories read as empty, so a machine without local plugins still
 * produces a valid snapshot.
 * @param {string} base
 * @returns {Promise<Record<string, string>>}
 */
async function collectTree(base) {
  const out = {}
  const walk = async (dir, prefix) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (TREE_IGNORE.has(entry.name)) continue
      const absolute = join(dir, entry.name)
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      if (!TREE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const content = await readIfPresent(absolute)
      if (content !== undefined) out[relative] = content
    }
  }
  await walk(base, '')
  return out
}

/**
 * Build the portable snapshot of one profile: its manifest, patch layer, pnpm
 * inputs and patch files, plus the home-level patch layer. Conversations,
 * workspace state, caches, credentials and node_modules are never included.
 * @param {{home: string, profileDir: string}} paths
 */
export async function collectSnapshot(paths) {
  const files = {}
  for (const name of SNAPSHOT_FILES) {
    const content = await readIfPresent(join(paths.profileDir, name))
    if (content !== undefined) files[name] = content
  }

  const patchesDir = join(paths.profileDir, 'patches')
  if (existsSync(patchesDir)) {
    for (const entry of await readdir(patchesDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const content = await readIfPresent(join(patchesDir, entry.name))
      if (content !== undefined) files[`patches/${entry.name}`] = content
    }
  }

  for (const [relative, content] of Object.entries(await collectTree(join(paths.home, PLUGIN_TREE)))) {
    files[`${PLUGIN_TREE}/${relative}`] = content
  }

  const home = {}
  const homePatch = await readIfPresent(join(paths.home, 'cordis.patch.yml'))
  if (homePatch !== undefined) home['cordis.patch.yml'] = homePatch

  let manifest = {}
  if (files['package.json']) {
    try {
      manifest = JSON.parse(files['package.json'])
    } catch {
      throw new Error('本机 profile 的 package.json 不是合法 JSON，已停止导出。')
    }
  }

  return {
    schema: SNAPSHOT_SCHEMA,
    createdAt: new Date().toISOString(),
    source: {
      platform: process.platform,
      node: process.version,
      profile: paths.profile,
    },
    bundles: Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [],
    dependencies: Object.keys(manifest?.dependencies ?? {}),
    files,
    home,
  }
}

/**
 * Encode a snapshot for storage. Gzip keeps a large lockfile well under the
 * GitHub Contents API limit.
 * @param {object} snapshot
 * @returns {Buffer}
 */
export function encodeSnapshot(snapshot) {
  const raw = Buffer.from(JSON.stringify(snapshot), 'utf8')
  const packed = gzipSync(raw, { level: 9 })
  if (packed.length > MAX_SNAPSHOT_BYTES) {
    throw new Error(`快照压缩后仍有 ${(packed.length / 1048576).toFixed(1)} MiB，超过 4 MiB 上限。`)
  }
  return packed
}

/**
 * Decode and validate a downloaded snapshot.
 * @param {Buffer} buffer
 */
export function decodeSnapshot(buffer) {
  let snapshot
  try {
    snapshot = JSON.parse(gunzipSync(buffer).toString('utf8'))
  } catch (error) {
    throw new Error(`快照无法解压或解析：${error.message}`)
  }
  if (!snapshot || snapshot.schema !== SNAPSHOT_SCHEMA) throw new Error(`快照格式版本不受支持：${String(snapshot?.schema)}`)
  if (!snapshot.files || typeof snapshot.files !== 'object' || !snapshot.files['package.json']) {
    throw new Error('快照缺少 profile 的 package.json。')
  }
  return snapshot
}

/**
 * Keep this plugin installed and enabled when another machine's manifest is
 * applied, whatever spec this machine installed it with. Local `link:`/`file:`
 * specs are re-pointed at this machine's plugin tree, because the path stored
 * in the snapshot belongs to the machine that pushed it.
 * @param {object} manifest incoming profile manifest
 * @param {object|undefined} localManifest this machine's current manifest
 * @param {{home: string}|undefined} paths this machine's resolved paths
 * @param {string[]} localPackages relative paths carried under PLUGIN_TREE
 */
export function mergeManifest(manifest, localManifest, paths, localPackages = []) {
  const merged = structuredClone(manifest)
  merged.dependencies = { ...(merged.dependencies ?? {}) }
  const ownSpec = localManifest?.dependencies?.[PLUGIN_NAME]
  if (typeof ownSpec === 'string' && ownSpec.length > 0) merged.dependencies[PLUGIN_NAME] = ownSpec
  if (paths !== undefined && Array.isArray(localPackages) && localPackages.length > 0) {
    const root = join(paths.home, PLUGIN_TREE)
    const names = new Set(localPackages.map((relative) => relative.split('/')[0]).filter(Boolean))
    for (const [name, spec] of Object.entries(merged.dependencies)) {
      if (typeof spec !== 'string') continue
      if (!/^(?:link|file):/i.test(spec)) continue
      if (!names.has(name)) continue
      merged.dependencies[name] = `link:${join(root, name).replace(/\\/g, '/')}`
    }
  }
  merged.dsh = { ...(merged.dsh ?? {}) }
  merged.dsh.profile = { ...(merged.dsh.profile ?? {}) }
  const bundles = Array.isArray(merged.dsh.profile.bundles) ? [...merged.dsh.profile.bundles] : []
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
  merged.dsh.profile.bundles = bundles
  return merged
}

function stamp() {
  const now = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/**
 * Back up, then write the snapshot over this profile. The plugin's own
 * dependency and bundle row are preserved.
 * @param {object} snapshot decoded snapshot
 * @param {{home: string, profileDir: string}} paths
 * @returns {Promise<{written: number, backupDir: string}>}
 */
export async function applySnapshot(snapshot, paths) {
  const files = { ...snapshot.files }
  for (const relative of Object.keys(files)) assertSafeRelative(relative)

  // Plugin sources are written under the DSH home, not the profile, so they are
  // split out before the profile-relative files are validated and written.
  const localFiles = {}
  for (const relative of Object.keys(files)) {
    if (!relative.startsWith(`${PLUGIN_TREE}/`)) continue
    localFiles[relative.slice(PLUGIN_TREE.length + 1)] = files[relative]
    delete files[relative]
  }

  const localManifestRaw = await readIfPresent(join(paths.profileDir, 'package.json'))
  let localManifest
  if (localManifestRaw) {
    try {
      localManifest = JSON.parse(localManifestRaw)
    } catch {
      localManifest = undefined
    }
  }

  const merged = mergeManifest(JSON.parse(files['package.json']), localManifest, paths, Object.keys(localFiles))
  files['package.json'] = JSON.stringify(merged, null, 2) + '\n'

  const backupDir = join(paths.home, `cloud-sync-backup-${stamp()}`)
  for (const name of SNAPSHOT_FILES) {
    const source = join(paths.profileDir, name)
    if (!existsSync(source)) continue
    await mkdir(backupDir, { recursive: true })
    await copyFile(source, join(backupDir, name))
  }
  const backupPatches = join(paths.profileDir, 'patches')
  if (existsSync(backupPatches)) {
    await mkdir(join(backupDir, 'patches'), { recursive: true })
    for (const entry of await readdir(backupPatches, { withFileTypes: true })) {
      if (entry.isFile()) await copyFile(join(backupPatches, entry.name), join(backupDir, 'patches', entry.name))
    }
  }
  const localHomePatch = join(paths.home, 'cordis.patch.yml')
  if (existsSync(localHomePatch)) {
    await mkdir(backupDir, { recursive: true })
    await copyFile(localHomePatch, join(backupDir, 'home-cordis.patch.yml'))
  }

  // Back up this machine's plugin tree before it is overwritten.
  const existingTree = await collectTree(join(paths.home, PLUGIN_TREE))
  for (const [relative, content] of Object.entries(existingTree)) {
    const target = join(backupDir, PLUGIN_TREE, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  for (const [relative, content] of Object.entries(files)) {
    const target = join(paths.profileDir, relative)
    const root = resolve(paths.profileDir) + sep
    if (!resolve(target).startsWith(root)) throw new Error(`快照路径越界：${relative}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  const home = snapshot.home && typeof snapshot.home === 'object' ? snapshot.home : {}
  const homeTarget = join(paths.home, 'cordis.patch.yml')
  if (typeof home['cordis.patch.yml'] === 'string') {
    await mkdir(paths.home, { recursive: true })
    await writeFile(homeTarget, home['cordis.patch.yml'], 'utf8')
  }

  const localRoot = resolve(paths.home, PLUGIN_TREE)
  for (const [relative, content] of Object.entries(localFiles)) {
    assertSafeRelative(relative)
    const target = join(localRoot, relative)
    if (!resolve(target).startsWith(localRoot + sep)) throw new Error(`本地插件路径越界：${relative}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  return { written: Object.keys(files).length + Object.keys(localFiles).length, backupDir }
}

/**
 * Locate the bundled pnpm entry and the runtime that should execute it.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{runner: string, pnpm: string}|null}
 */
export function findPnpm(env = process.env) {
  const candidates = []
  if (env.DSH_CLOUD_SYNC_PNPM) candidates.push(env.DSH_CLOUD_SYNC_PNPM)
  const execDir = dirname(process.execPath)
  candidates.push(join(execDir, '..', '..', 'pnpm', 'bin', 'pnpm.mjs'))
  candidates.push(join(execDir, '..', 'pnpm', 'bin', 'pnpm.mjs'))
  candidates.push(join(execDir, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  if (process.resourcesPath) {
    candidates.push(join(process.resourcesPath, 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  }
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  }
  const pnpm = candidates.find((candidate) => candidate && existsSync(candidate))
  return pnpm ? { runner: process.execPath, pnpm } : null
}

/**
 * Reconcile node_modules with the restored manifest and lockfile.
 * @param {{runner: string, pnpm: string}} tool
 * @param {string} profileDir
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, output: string}>}
 */
export function runPnpmInstall(tool, profileDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  return new Promise((resolvePromise) => {
    const child = spawn(tool.runner, [tool.pnpm, 'install', '--dir', profileDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let output = ''
    const append = (chunk) => {
      output += chunk
      if (output.length > 200000) output = output.slice(-100000)
    }
    child.stdout.on('data', (chunk) => append(String(chunk)))
    child.stderr.on('data', (chunk) => append(String(chunk)))
    const timer = setTimeout(() => {
      child.kill()
      append(`\n[cloud-sync] pnpm install 超时（${Math.round(timeoutMs / 1000)}s），已终止。`)
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, code: null, output: `无法启动 pnpm：${error.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, output })
    })
  })
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'dsh-cloud-sync',
  }
}

function repoUrl(repo) {
  return `https://api.github.com/repos/${repo}`
}

function contentUrl(repo, path, branch) {
  const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return `${repoUrl(repo)}/contents/${encoded}?ref=${encodeURIComponent(branch)}`
}

/**
 * Read one file from a repository.
 * @returns {Promise<{sha: string, content: Buffer}|null>} null when the file is absent
 */
export async function githubRead({ token, repo, path, branch, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(contentUrl(repo, path, branch), { headers: githubHeaders(token) })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(await describeFailure(response))
  const body = await response.json()
  if (typeof body.content === 'string' && body.content.length > 0) {
    return { sha: body.sha, content: Buffer.from(body.content, 'base64') }
  }
  if (typeof body.download_url === 'string' && body.download_url.length > 0) {
    const raw = await fetchImpl(body.download_url, { headers: { 'User-Agent': 'dsh-cloud-sync', Accept: 'application/octet-stream' } })
    if (!raw.ok) throw new Error(`下载快照失败：HTTP ${raw.status}`)
    return { sha: body.sha, content: Buffer.from(await raw.arrayBuffer()) }
  }
  throw new Error('GitHub 返回的内容为空，且没有可用的下载地址。')
}

/**
 * Create or replace one file in a repository.
 * @returns {Promise<{sha: string, created: boolean}>}
 */
export async function githubWrite({ token, repo, path, branch, content, message, fetchImpl = globalThis.fetch }) {
  let sha
  try {
    const existing = await githubRead({ token, repo, path, branch, fetchImpl })
    if (existing) sha = existing.sha
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error
  }
  const payload = {
    message: message ?? `cloud-sync: update ${path}`,
    content: content.toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  }
  const put = (body) => fetchImpl(contentUrl(repo, path, branch), {
    method: 'PUT',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  let response = await put(payload)
  // An empty repository has no branch yet; the first commit must omit `branch`
  // so GitHub creates the repository's default branch.
  if (!response.ok && !sha && [404, 409, 422].includes(response.status)) {
    const { branch: _omitted, ...withoutBranch } = payload
    response = await put(withoutBranch)
  }
  if (!response.ok) throw new Error(await describeFailure(response))
  const body = await response.json()
  return { sha: body?.content?.sha ?? '', created: !sha }
}

async function describeFailure(response) {
  let detail = ''
  try {
    const body = await response.json()
    detail = typeof body?.message === 'string' ? body.message : JSON.stringify(body)
  } catch {
    detail = ''
  }
  return `GitHub 请求失败：HTTP ${response.status}${detail ? ` — ${detail}` : ''}`
}

/**
 * Upload a snapshot to the configured repository.
 * @returns {Promise<{sha: string, created: boolean, bytes: number}>}
 */
export async function uploadSnapshot({ token, repo, branch, path, snapshot, message, fetchImpl }) {
  const packed = encodeSnapshot(snapshot)
  const result = await githubWrite({ token, repo, branch, path, content: packed, message, fetchImpl })
  return { ...result, bytes: packed.length }
}

/**
 * List one directory in a repository.
 * @returns {Promise<Array<{name: string, path: string, sha: string, size: number}>>}
 */
export async function githubList({ token, repo, path, branch, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(contentUrl(repo, path, branch), { headers: githubHeaders(token) })
  if (response.status === 404) return []
  if (!response.ok) throw new Error(await describeFailure(response))
  const body = await response.json()
  if (!Array.isArray(body)) return []
  return body.map((entry) => ({
    name: String(entry.name),
    path: String(entry.path),
    sha: String(entry.sha),
    size: Number(entry.size ?? 0),
  }))
}

/**
 * Download and decode the snapshot from the configured repository.
 * @returns {Promise<{snapshot: object, sha: string, bytes: number}|null>}
 */
export async function downloadSnapshot({ token, repo, branch, path, fetchImpl }) {
  const file = await githubRead({ token, repo, path, branch, fetchImpl })
  if (!file) return null
  return { snapshot: decodeSnapshot(file.content), sha: file.sha, bytes: file.content.length }
}

function sortedObject(object) {
  const sorted = {}
  for (const key of Object.keys(object ?? {}).sort()) sorted[key] = object[key]
  return sorted
}

/**
 * Content identity used to decide whether two snapshots already agree.
 * Creation time, source machine and encoding metadata are ignored.
 * @param {object} snapshot
 * @returns {string}
 */
export function contentDigest(snapshot) {
  const canonical = {
    files: sortedObject(snapshot.files),
    home: sortedObject(snapshot.home ?? {}),
    bundles: snapshot.bundles ?? [],
    dependencies: [...(snapshot.dependencies ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Stable, path-safe name for this machine. */
export function deviceName() {
  const raw = `${hostname()}-${process.platform}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return raw || 'device'
}

/**
 * Two-way merge with the remote snapshot as the base:
 * - the plugin list is a union (remote order first, then this machine's extras);
 * - a dependency only this machine has is kept;
 * - this machine's `link:`/`file:` installs stay local, so a path from another
 *   machine never replaces a working local install;
 * - everything else (settings, lockfile, patches) follows the remote snapshot;
 * - a home patch only this machine has is kept when the remote has none.
 * @param {object} local
 * @param {object} remote
 */
export function mergeSnapshots(local, remote) {
  const remoteManifest = JSON.parse(remote.files['package.json'])
  const localManifest = JSON.parse(local.files['package.json'])
  const manifest = mergeManifest(remoteManifest, localManifest)

  const baseBundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const addedBundles = (local.bundles ?? []).filter((bundle) => !baseBundles.includes(bundle))
  manifest.dsh.profile.bundles = [...baseBundles, ...addedBundles]

  const addedDependencies = []
  for (const [name, localSpec] of Object.entries(localManifest.dependencies ?? {})) {
    if (typeof localSpec !== 'string') continue
    const remoteSpec = manifest.dependencies[name]
    if (remoteSpec === undefined) {
      manifest.dependencies[name] = localSpec
      addedDependencies.push(name)
      continue
    }
    if (/^(link|file):/.test(localSpec)) manifest.dependencies[name] = localSpec
  }

  const files = { ...remote.files }
  for (const [relative, content] of Object.entries(local.files)) {
    if (relative === 'package.json') continue
    if (files[relative] === undefined) files[relative] = content
  }
  files['package.json'] = JSON.stringify(manifest, null, 2) + '\n'

  const home = remote.home && remote.home['cordis.patch.yml'] !== undefined
    ? { ...remote.home }
    : { ...(local.home ?? {}) }

  return {
    snapshot: {
      ...remote,
      schema: SNAPSHOT_SCHEMA,
      createdAt: new Date().toISOString(),
      source: { ...(remote.source ?? {}), mergedBy: { device: deviceName(), platform: process.platform } },
      bundles: manifest.dsh.profile.bundles,
      dependencies: Object.keys(manifest.dependencies),
      files,
      home,
    },
    stats: {
      addedBundles,
      addedDependencies,
      keptLocalOnlyFiles: Object.keys(local.files).filter((relative) => relative !== 'package.json' && remote.files[relative] === undefined),
    },
  }
}

/**
 * Archive a snapshot under `backups/` before it is overwritten.
 * @returns {Promise<string>} repository path of the archive
 */
export async function uploadBackup({ token, repo, branch, pathPrefix = 'backups', snapshot, fetchImpl }) {
  const packed = encodeSnapshot(snapshot)
  const path = `${pathPrefix}/${stamp()}-${deviceName()}.json.gz`
  await githubWrite({
    token,
    repo,
    branch,
    path,
    content: packed,
    message: `cloud-sync: backup before sync (${deviceName()})`,
    fetchImpl,
  })
  return path
}
