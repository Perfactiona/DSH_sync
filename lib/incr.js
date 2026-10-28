/**
 * Incremental storage for dsh-cloud-sync.
 *
 * One gz per push meant every push re-uploaded everything and had to stay under
 * a small request budget. This module instead stores the snapshot as
 * content-addressed files:
 *
 *   <dir>/state.json          index: schema, metadata, and `path → sha256`
 *   <dir>/files/<path>        one plain-text file per snapshot entry
 *
 * A push reads the index, compares digests and uploads only the paths whose
 * content changed; unchanged files are never sent again. GitHub's own limits
 * (100 MB per file) then apply per file rather than to one giant blob.
 */
import { createHash } from 'node:crypto'
import { githubRead, githubWrite } from './core.js'

/** Index format written by this module. */
export const INCREMENTAL_SCHEMA = 2
/** File that holds the index. */
const STATE_FILE = 'state.json'
/** Directory that holds one file per snapshot entry. */
const FILES_DIR = 'files'

/**
 * @param {string} text
 * @returns {string} hex sha256
 */
export function digestOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Turn a collected snapshot into the small index that describes it.
 * @param {object} snapshot
 */
export function indexOf(snapshot) {
  const tree = {}
  for (const [path, content] of Object.entries(snapshot.files ?? {})) tree[path] = digestOf(content)
  return {
    schema: INCREMENTAL_SCHEMA,
    createdAt: snapshot.createdAt,
    source: snapshot.source,
    bundles: snapshot.bundles,
    dependencies: snapshot.dependencies,
    home: snapshot.home ?? {},
    tree,
  }
}

/**
 * @param {object|null} remoteIndex
 * @param {object} localIndex
 * @returns {string[]} paths whose content differs or is missing remotely
 */
export function changedPaths(remoteIndex, localIndex) {
  const remote = remoteIndex?.tree ?? {}
  return Object.keys(localIndex.tree).filter((path) => remote[path] !== localIndex.tree[path])
}

/**
 * @returns {boolean} whether two indexes describe the same content
 */
export function treesEqual(left, right) {
  const keysLeft = Object.keys(left).sort()
  const keysRight = Object.keys(right).sort()
  if (keysLeft.length !== keysRight.length) return false
  for (let index = 0; index < keysLeft.length; index += 1) {
    if (keysLeft[index] !== keysRight[index]) return false
    if (left[keysLeft[index]] !== right[keysRight[index]]) return false
  }
  return true
}

/**
 * @param {string} configPath the configured snapshot path; its directory hosts the index
 */
export function layout(configPath) {
  const trimmed = String(configPath ?? '').replace(/^\/+/, '')
  const slash = trimmed.lastIndexOf('/')
  const dir = slash < 0 ? '' : trimmed.slice(0, slash)
  const prefix = dir === '' ? '' : `${dir}/`
  return {
    state: `${prefix}${STATE_FILE}`,
    file: (path) => `${prefix}${FILES_DIR}/${path}`,
  }
}

/**
 * @returns {Promise<object|null>} the remote index, or null when none exists
 */
export async function readIndex({ token, repo, branch, configPath, fetchImpl = globalThis.fetch }) {
  const files = layout(configPath)
  const file = await githubRead({ token, repo, path: files.state, branch, fetchImpl })
  if (!file) return null
  let parsed
  try {
    parsed = JSON.parse(file.content.toString('utf8'))
  } catch {
    throw new Error('云端 state.json 无法解析')
  }
  if (parsed?.schema !== INCREMENTAL_SCHEMA || typeof parsed.tree !== 'object' || parsed.tree === null) {
    throw new Error('云端元数据格式不受支持（可能来自旧版单文件快照），请先在一台机器上重新 push。')
  }
  return parsed
}

/**
 * Upload only what changed, then the index itself.
 * @returns {Promise<{uploaded: number, skipped: number, index: object}>}
 */
export async function writeSnapshot({ token, repo, branch, configPath, snapshot, fetchImpl = globalThis.fetch }) {
  const files = layout(configPath)
  const local = indexOf(snapshot)
  let remote = null
  try {
    remote = await readIndex({ token, repo, branch, configPath, fetchImpl })
  } catch {
    remote = null
  }
  const changed = changedPaths(remote, local)
  for (const path of changed) {
    const content = snapshot.files[path]
    await githubWrite({
      token,
      repo,
      branch,
      path: files.file(path),
      content: Buffer.from(content, 'utf8'),
      message: `cloud-sync: ${path}`,
      fetchImpl,
    })
  }
  await githubWrite({
    token,
    repo,
    branch,
    path: files.state,
    content: Buffer.from(`${JSON.stringify(local, null, 2)}\n`, 'utf8'),
    message: `cloud-sync: index (${changed.length} changed, ${Object.keys(local.tree).length} total)`,
    fetchImpl,
  })
  return { uploaded: changed.length, skipped: Object.keys(local.tree).length - changed.length, index: local }
}

/**
 * Download the index, then every file it names, verifying each digest.
 * @returns {Promise<object|null>} a snapshot object, or null when none exists
 */
export async function readSnapshot({ token, repo, branch, configPath, fetchImpl = globalThis.fetch }) {
  const files = layout(configPath)
  const index = await readIndex({ token, repo, branch, configPath, fetchImpl })
  if (index === null) return null
  const texts = {}
  for (const path of Object.keys(index.tree)) {
    const file = await githubRead({ token, repo, path: files.file(path), branch, fetchImpl })
    if (!file) throw new Error(`云端缺少文件：${path}`)
    const text = file.content.toString('utf8')
    if (digestOf(text) !== index.tree[path]) throw new Error(`云端文件校验失败（内容与索引不符）：${path}`)
    texts[path] = text
  }
  return {
    schema: index.schema,
    createdAt: index.createdAt,
    source: index.source,
    bundles: index.bundles,
    dependencies: index.dependencies,
    files: texts,
    home: index.home ?? {},
  }
}
