import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLUGIN_NAME,
  applySnapshot,
  collectSnapshot,
  contentDigest,
  decodeSnapshot,
  encodeSnapshot,
  findPnpm,
  githubRead,
  githubWrite,
  mergeManifest,
  mergeSnapshots,
  resolvePaths,
} from '../lib/core.js'

const root = process.argv[2]
if (!root) throw new Error('usage: test-core.mjs <scratch-dir>')
await rm(root, { recursive: true, force: true })

const home = join(root, 'home')
const profileDir = join(home, 'profiles', 'desktop')
await mkdir(join(profileDir, 'patches'), { recursive: true })
await mkdir(join(home, 'storages'), { recursive: true })

await writeFile(join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-desktop',
  dependencies: {
    'some-plugin': '1.2.3',
    [PLUGIN_NAME]: 'link:C:/work/dsh-cloud-sync',
  },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'some-plugin', PLUGIN_NAME] } },
}, null, 2))
await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    fontSize: 16\n')
await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
await writeFile(join(profileDir, 'patches', 'some-plugin@1.2.3.patch'), 'diff\n')
await writeFile(join(home, 'cordis.patch.yml'), '- id: ui-chat\n  config: {}\n')
await writeFile(join(home, 'storages', 'workspace.json'), '{"tables":{}}')
await writeFile(join(home, 'sessions', 'x.jsonl'), 'secret conversation').catch(() => {})

// 1. path resolution
const paths = resolvePaths({ DSH_HOME: home, DSH_PROFILE: 'desktop' })
assert.equal(paths.home, home)
assert.equal(paths.profileDir, profileDir)

// 2. collection excludes sessions/storages
const snapshot = await collectSnapshot(paths)
assert.deepEqual(snapshot.bundles, ['@deepseek-ai/dsh-base', 'some-plugin', PLUGIN_NAME])
assert.deepEqual(snapshot.dependencies, ['some-plugin', PLUGIN_NAME])
assert.deepEqual(Object.keys(snapshot.files).sort(), [
  'cordis.patch.yml', 'package.json', 'patches/some-plugin@1.2.3.patch',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml',
])
assert.equal(snapshot.home['cordis.patch.yml'], '- id: ui-chat\n  config: {}\n')
assert.ok(!JSON.stringify(snapshot).includes('secret conversation'))

// 3. encode / decode round trip
const packed = encodeSnapshot(snapshot)
const decoded = decodeSnapshot(packed)
assert.deepEqual(decoded.files, snapshot.files)
assert.equal(decoded.schema, 1)

// 4. manifest merge keeps this machine's own spec and row
const merged = mergeManifest(
  { dependencies: { 'some-plugin': '9.9.9' }, dsh: { profile: { bundles: ['some-plugin'] } } },
  { dependencies: { [PLUGIN_NAME]: 'https://example.test/dsh-cloud-sync.tar.gz' } },
)
assert.equal(merged.dependencies[PLUGIN_NAME], 'https://example.test/dsh-cloud-sync.tar.gz')
assert.equal(merged.dependencies['some-plugin'], '9.9.9')
assert.deepEqual(merged.dsh.profile.bundles, ['some-plugin', PLUGIN_NAME])

// 5. apply writes files, backs up, preserves own dependency
const targetHome = join(root, 'target')
const targetProfile = join(targetHome, 'profiles', 'desktop')
await mkdir(targetProfile, { recursive: true })
await writeFile(join(targetProfile, 'package.json'), JSON.stringify({
  dependencies: { [PLUGIN_NAME]: 'https://example.test/dsh-cloud-sync.tar.gz' },
  dsh: { profile: { bundles: [PLUGIN_NAME] } },
}))
await writeFile(join(targetProfile, 'cordis.patch.yml'), '- id: old\n  config: {}\n')
const applied = await applySnapshot(decoded, { home: targetHome, profileDir: targetProfile })
assert.equal(applied.written, 5)
assert.ok(existsSync(applied.backupDir))
const writtenManifest = JSON.parse(await readFile(join(targetProfile, 'package.json'), 'utf8'))
assert.equal(writtenManifest.dependencies[PLUGIN_NAME], 'https://example.test/dsh-cloud-sync.tar.gz')
assert.deepEqual(writtenManifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'some-plugin', PLUGIN_NAME])
assert.equal(await readFile(join(targetProfile, 'patches', 'some-plugin@1.2.3.patch'), 'utf8'), 'diff\n')
assert.ok(existsSync(join(targetHome, 'cordis.patch.yml')))

// 6. path traversal is rejected
await assert.rejects(
  () => applySnapshot({ files: { 'package.json': '{}', '../escape.txt': 'x' } }, { home: targetHome, profileDir: targetProfile }),
  /escapes the profile/,
)

// 7. GitHub helpers: create then update, with a fake fetch
const calls = []
let stored = null
const fetchImpl = async (url, init = {}) => {
  calls.push({ url, method: init.method ?? 'GET' })
  if (!init.method || init.method === 'GET') {
    if (!stored) return { status: 404, ok: false, json: async () => ({ message: 'Not Found' }) }
    return { ok: true, status: 200, json: async () => ({ sha: 'sha-1', content: stored.toString('base64'), encoding: 'base64' }) }
  }
  if (init.method === 'PUT') {
    const body = JSON.parse(init.body)
    if (stored) assert.equal(body.sha, 'sha-1')
    else assert.equal(body.sha, undefined)
    stored = Buffer.from(body.content, 'base64')
    return { ok: true, status: 200, json: async () => ({ content: { sha: 'sha-2' } }) }
  }
  throw new Error(`unexpected ${init.method}`)
}
assert.equal(await githubRead({ token: 't', repo: 'me/data', path: 'dsh-sync/snapshot.json.gz', branch: 'main', fetchImpl }), null)
const created = await githubWrite({ token: 't', repo: 'me/data', path: 'dsh-sync/snapshot.json.gz', branch: 'main', content: Buffer.from('hello'), fetchImpl })
assert.equal(created.created, true)
const updated = await githubWrite({ token: 't', repo: 'me/data', path: 'dsh-sync/snapshot.json.gz', branch: 'main', content: Buffer.from('hello2'), fetchImpl })
assert.equal(updated.created, false)
assert.ok(calls.some((call) => call.method === 'PUT'))

// 8. empty repository: first PUT without a branch creates the default branch
const emptyCalls = []
const emptyFetch = async (url, init = {}) => {
  if (!init.method || init.method === 'GET') {
    return { status: 404, ok: false, json: async () => ({ message: 'Not Found' }) }
  }
  const body = JSON.parse(init.body)
  emptyCalls.push(body)
  if (Object.hasOwn(body, 'branch')) {
    return { status: 422, ok: false, json: async () => ({ message: 'Branch main not found' }) }
  }
  return { ok: true, status: 201, json: async () => ({ content: { sha: 'sha-empty' } }) }
}
const emptyWrite = await githubWrite({ token: 't', repo: 'me/empty', path: 'dsh-sync/snapshot.json.gz', branch: 'main', content: Buffer.from('x'), fetchImpl: emptyFetch })
assert.equal(emptyWrite.created, true)
assert.equal(emptyCalls.length, 2)
assert.ok(Object.hasOwn(emptyCalls[0], 'branch'))
assert.ok(!Object.hasOwn(emptyCalls[1], 'branch'))

// 8. digest ignores creation time and source metadata
const later = { ...decoded, createdAt: new Date().toISOString(), source: { platform: 'other' } }
assert.equal(contentDigest(decoded), contentDigest(later))

// 9. two-way merge: union bundles, keep local-only deps, local link specs, remote settings
const localSnap = {
  files: {
    'package.json': JSON.stringify({
      dependencies: { 'local-only': '1.0.0', shared: '1.0.0', [PLUGIN_NAME]: 'link:C:/work/plugin' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'local-only', PLUGIN_NAME] } },
    }),
    'cordis.patch.yml': 'local settings',
  },
  home: { 'cordis.patch.yml': 'local home' },
  bundles: ['@deepseek-ai/dsh-base', 'local-only', PLUGIN_NAME],
  dependencies: ['local-only', 'shared', PLUGIN_NAME],
}
const remoteSnap = {
  files: {
    'package.json': JSON.stringify({
      dependencies: { shared: '2.0.0', 'remote-only': '3.0.0', [PLUGIN_NAME]: 'https://example.test/plugin.tar.gz' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'shared'] } },
    }),
    'cordis.patch.yml': 'remote settings',
  },
  home: { 'cordis.patch.yml': 'remote home' },
  bundles: ['@deepseek-ai/dsh-base', 'shared'],
  dependencies: ['shared', 'remote-only', PLUGIN_NAME],
}
const { snapshot: mergedSnap, stats } = mergeSnapshots(localSnap, remoteSnap)
const mergedPkg = JSON.parse(mergedSnap.files['package.json'])
assert.deepEqual(mergedPkg.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'shared', PLUGIN_NAME, 'local-only'])
assert.equal(mergedPkg.dependencies.shared, '2.0.0')
assert.equal(mergedPkg.dependencies['remote-only'], '3.0.0')
assert.equal(mergedPkg.dependencies['local-only'], '1.0.0')
assert.equal(mergedPkg.dependencies[PLUGIN_NAME], 'link:C:/work/plugin')
assert.deepEqual(stats.addedBundles, ['local-only'])
assert.equal(mergedSnap.files['cordis.patch.yml'], 'remote settings')
assert.equal(mergedSnap.home['cordis.patch.yml'], 'remote home')

// 10. bundled pnpm is discoverable from the running Node
const tool = findPnpm()
assert.ok(tool, 'expected the bundled pnpm to be discoverable')
assert.ok(existsSync(tool.pnpm))

console.log('core.test: all assertions passed')
