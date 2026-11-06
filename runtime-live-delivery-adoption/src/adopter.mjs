import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BASE = '421d2a9f3a900cd73991d86511307d2e596a3711'
export const METHODS = Object.freeze({
  AitermTransport: ['ensure', 'memberOperation', 'requireDeliveryKnown', 'submit', 'dispatch'],
  BotSessionState: ['awaitUnboundAdmission', 'requireDeliveryKnown'],
})
const NAMES = Object.freeze({ AitermTransport: 'aiterm-transport.mjs', BotSessionState: 'bot-session-state.mjs' })
const ROOT = '/run/bellteam-live-delivery-adoptions'
export const STATE_ROOT = '/srv/bellteam/state/runtime-adoptions'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const inFlight = new Map()
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')
export const fail = code => { throw Object.assign(new Error(code), { code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const exact = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',')
const functionInfo = value => {
  const text = Function.prototype.toString.call(value)
  return { bytes: Buffer.byteLength(text), sha256: digest(text) }
}
const matches = (value, expected) => typeof value === 'function'
  && functionInfo(value).bytes === expected.bytes && functionInfo(value).sha256 === expected.sha256
const descriptorValid = descriptor => descriptor && typeof descriptor.value === 'function'
  && descriptor.writable === true && descriptor.configurable === true && descriptor.enumerable === false

export function validateProfile(profile) {
  check(exact(profile, ['schema', 'baseSourceCommit', 'backportSourceCommit', 'modules'])
    && profile.schema === 'bellteam.live-delivery-profile.v1' && profile.baseSourceCommit === BASE
    && COMMIT.test(profile.backportSourceCommit ?? '') && Array.isArray(profile.modules)
    && profile.modules.length === 2, 'LIVE_PROFILE_INVALID')
  for (const [index, className] of Object.keys(METHODS).entries()) {
    const module = profile.modules[index]
    check(exact(module, ['class', 'file', 'beforeFileSha256', 'sourceFileSha256', 'methods'])
      && module.class === className && module.file === NAMES[className]
      && SHA.test(module.beforeFileSha256 ?? '') && SHA.test(module.sourceFileSha256 ?? '')
      && Array.isArray(module.methods) && module.methods.length === METHODS[className].length, 'LIVE_PROFILE_INVALID')
    module.methods.forEach((method, number) => {
      check(exact(method, ['class', 'method', 'role', 'before', 'after', 'descriptor'])
        && method.class === className && method.method === METHODS[className][number]
        && method.role === (method.method === 'requireDeliveryKnown' ? 'old-closure-compatibility' : 'replacement')
        && exact(method.descriptor, ['writable', 'enumerable', 'configurable'])
        && method.descriptor.writable === true && method.descriptor.configurable === true && method.descriptor.enumerable === false,
      'LIVE_PROFILE_INVALID')
      for (const side of ['before', 'after']) check(exact(method[side], ['bytes', 'sha256'])
        && Number.isSafeInteger(method[side].bytes) && method[side].bytes > 0 && method[side].bytes <= 65536
        && SHA.test(method[side].sha256 ?? ''), 'LIVE_PROFILE_INVALID')
    })
  }
  return profile
}

// Capture only descriptors; no execution owner is reconstructed or transferred.
export function prepareDescriptorChanges(profile, original, repaired) {
  validateProfile(profile)
  const changes = []
  for (const module of profile.modules) {
    const before = original[module.class]?.prototype, after = repaired[module.class]?.prototype
    check(before && after && before !== after, 'LIVE_CLASS_INVALID')
    const keys = Reflect.ownKeys(before)
    check(JSON.stringify(keys) === JSON.stringify(Reflect.ownKeys(after)), 'LIVE_PROTOTYPE_SHAPE_CHANGED')
    for (const name of keys.filter(name => name !== 'constructor' && !METHODS[module.class].includes(name))) {
      const left = Object.getOwnPropertyDescriptor(before, name), right = Object.getOwnPropertyDescriptor(after, name)
      check(left.configurable === right.configurable && left.enumerable === right.enumerable && left.writable === right.writable,
        'LIVE_OTHER_DESCRIPTOR_CHANGED')
      for (const slot of ['value', 'get', 'set']) check(typeof left[slot] === 'function'
        ? typeof right[slot] === 'function' && digest(Function.prototype.toString.call(left[slot])) === digest(Function.prototype.toString.call(right[slot]))
        : left[slot] === right[slot], 'LIVE_OTHER_DESCRIPTOR_CHANGED')
    }
    for (const method of module.methods) {
      const old = Object.getOwnPropertyDescriptor(before, method.method)
      const next = Object.getOwnPropertyDescriptor(after, method.method)
      check(descriptorValid(old) && descriptorValid(next) && matches(old.value, method.before)
        && matches(next.value, method.after), 'LIVE_METHOD_FINGERPRINT_CHANGED')
      // Parsing outside the original class rejects undeclared private-name access.
      try { new Function(`return class { ${Function.prototype.toString.call(next.value)} }`) }
      catch { fail('LIVE_PRIVATE_METHOD_DEPENDENCY') }
      changes.push({ prototype: before, method, old, next })
    }
  }
  let committed = false
  return {
    commit() {
      check(!committed, 'LIVE_COMMIT_ALREADY_ISSUED')
      for (const item of changes) {
        const actual = Object.getOwnPropertyDescriptor(item.prototype, item.method.method)
        check(descriptorValid(actual) && actual.value === item.old.value && matches(actual.value, item.method.before),
          'LIVE_METHOD_FINGERPRINT_CHANGED')
      }
      committed = true
      const written = []
      try {
        for (const item of changes) {
          Object.defineProperty(item.prototype, item.method.method, item.next)
          written.push(item)
        }
      } catch (error) {
        for (const item of written.reverse()) Object.defineProperty(item.prototype, item.method.method, item.old)
        throw error
      }
      return changes.map(item => ({ class: item.method.class, method: item.method.method,
        ...functionInfo(Object.getOwnPropertyDescriptor(item.prototype, item.method.method).value) }))
    },
  }
}

export async function trustedFile(path, maximum, uid = 0, expectedSha) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    check(before.isFile() && before.uid === uid && before.nlink === 1 && !(before.mode & 0o7022)
      && before.size > 0 && before.size <= maximum, 'LIVE_FILE_UNTRUSTED')
    const bytes = await file.readFile()
    const after = await file.stat()
    check(bytes.length === before.size && before.ino === after.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && (!expectedSha || digest(bytes) === expectedSha), 'LIVE_FILE_CHANGED')
    return bytes
  } finally { await file.close() }
}

async function trustedDirectory(path, uid, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path)
  check(info.isDirectory() && info.uid === uid && !(info.mode & 0o7022), 'LIVE_DIRECTORY_UNTRUSTED')
}

export async function nonceDirectory(operationId) {
  check(UUID.test(operationId ?? ''), 'LIVE_OPERATION_INVALID')
  await trustedDirectory('/srv/bellteam/state', 1001)
  await trustedDirectory(STATE_ROOT, 1001, true)
  const directory = join(STATE_ROOT, operationId)
  await trustedDirectory(directory, 1001, true)
  return directory
}

export async function saveExclusive(path, value) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync() }
  finally { await file.close() }
  const directory = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

export async function runtimeIdentity(pid = process.pid) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8')
  return { pid, startTicks: raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19],
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    pidNamespace: await readlink(`/proc/${pid}/ns/pid`), networkNamespace: await readlink(`/proc/${pid}/ns/net`) }
}

export async function loadOperation(path, expectedSha) {
  check(SHA.test(expectedSha ?? ''), 'LIVE_OPERATION_INVALID')
  const match = new RegExp(`^${ROOT}/([a-f0-9-]+)/operation\\.json$`).exec(path)
  check(match && UUID.test(match[1]), 'LIVE_OPERATION_PATH_INVALID')
  await trustedDirectory('/run', 0)
  await trustedDirectory(ROOT, 0)
  await trustedDirectory(dirname(path), 0)
  const operation = JSON.parse(await trustedFile(path, 16384, 0, expectedSha))
  check(exact(operation, ['schema', 'operationId', 'target', 'policy'])
    && operation.schema === 'bellteam.live-delivery-operation.v1' && operation.operationId === match[1], 'LIVE_OPERATION_INVALID')
  const target = operation.target, policy = operation.policy
  check(exact(target, ['containerId', 'pid', 'startTicks', 'bootId', 'pidNamespace', 'networkNamespace'])
    && SHA.test(target.containerId ?? '') && Number.isSafeInteger(target.pid) && target.pid > 0
    && /^[0-9]+$/.test(target.startTicks ?? '') && /^[a-f0-9-]{36}$/.test(target.bootId ?? '')
    && /^pid:\[[0-9]+\]$/.test(target.pidNamespace ?? '') && /^net:\[[0-9]+\]$/.test(target.networkNamespace ?? ''), 'LIVE_OPERATION_INVALID')
  check(exact(policy, ['sourceCommit', 'backportSourceCommit', 'archiveSha256', 'manifestSha256', 'verificationSha256', 'adopterSha256'])
    && COMMIT.test(policy.sourceCommit ?? '') && COMMIT.test(policy.backportSourceCommit ?? '')
    && ['archiveSha256', 'manifestSha256', 'verificationSha256', 'adopterSha256'].every(key => SHA.test(policy[key] ?? '')),
  'LIVE_OPERATION_INVALID')
  return { operation, directory: dirname(path), operationSha256: expectedSha }
}

async function policyContext(path, sha) {
  check(process.getuid() === 1001 && process.getgid() === 1001 && process.argv[1] === '/app/src/supervisor.mjs'
    && process.cwd() === '/app', 'LIVE_PARENT_IDENTITY_CHANGED')
  const context = await loadOperation(path, sha)
  const { operation, directory } = context, actual = await runtimeIdentity()
  for (const key of ['pid', 'startTicks', 'bootId', 'pidNamespace', 'networkNamespace'])
    check(actual[key] === operation.target[key], 'LIVE_PARENT_IDENTITY_CHANGED')
  const distribution = JSON.parse(await trustedFile('/app/distribution.json', 4096))
  check(distribution.schema === 'bellteam.server.distribution.v1' && distribution.sourceCommit === BASE, 'LIVE_PARENT_SOURCE_CHANGED')
  const manifest = JSON.parse(await trustedFile(join(directory, 'manifest.json'), 65536, 0, operation.policy.manifestSha256))
  const verified = JSON.parse(await trustedFile(join(directory, 'verification.json'), 65536, 0, operation.policy.verificationSha256))
  check(manifest.schema === 'bellteam.live-delivery-policy.v1' && manifest.sourceCommit === operation.policy.sourceCommit
    && manifest.signerCommit === operation.policy.sourceCommit && manifest.profile?.backportSourceCommit === operation.policy.backportSourceCommit
    && verified.schema === 'bellteam.live-delivery-verification.v1' && verified.sourceCommit === manifest.sourceCommit
    && verified.signerCommit === manifest.signerCommit && verified.archiveSha256 === operation.policy.archiveSha256
    && verified.manifestSha256 === operation.policy.manifestSha256
    && verified.verification?.method === 'github-oidc-attestation' && verified.verification?.repositoryId === '1404510084', 'LIVE_SUPPLY_BINDING_CHANGED')
  check(process.platform === 'linux' && Number(process.versions.node.split('.')[0]) === 26
    && manifest.platform?.os === 'linux' && manifest.platform?.nodeMajor === 26
    && manifest.platform?.arch === ({ x64: 'amd64', arm64: 'arm64' })[process.arch]
    && exact(manifest.platform, ['os', 'arch', 'nodeMajor']) && exact(verified.platform, ['os', 'arch', 'nodeMajor'])
    && ['os', 'arch', 'nodeMajor'].every(key => verified.platform[key] === manifest.platform[key]), 'LIVE_PLATFORM_CHANGED')
  validateProfile(manifest.profile)
  check(manifest.files?.['src/adopter.mjs']?.sha256 === operation.policy.adopterSha256
    && fileURLToPath(import.meta.url) === join(directory, 'src/adopter.mjs'), 'LIVE_ADOPTER_CHANGED')
  await trustedDirectory(join(directory, 'src'), 0)
  await trustedDirectory(join(directory, 'policy'), 0)
  await trustedFile(fileURLToPath(import.meta.url), 131072, 0, operation.policy.adopterSha256)
  return { ...context, manifest, identity: actual }
}

async function classes(context, repaired = true) {
  const require = createRequire('/app/src/supervisor.mjs'), original = {}, next = {}
  for (const module of context.manifest.profile.modules) {
    const oldPath = `/app/src/${module.file}`, nextPath = join(context.directory, 'policy', module.file)
    await trustedFile(oldPath, 131072, 0, module.beforeFileSha256)
    original[module.class] = require(oldPath)[module.class]
    if (repaired) {
      const info = context.manifest.files?.[`policy/${module.file}`]
      check(info && SHA.test(info.sha256 ?? ''), 'LIVE_POLICY_FILE_INVALID')
      await trustedFile(nextPath, 131072, 0, info.sha256)
      next[module.class] = require(nextPath)[module.class]
    }
  }
  return { original, repaired: next }
}

async function stored(directory, name) {
  try { return JSON.parse(await trustedFile(join(directory, name), 65536, 1001)) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function inspectLiveDeliveryPolicy(path, sha) {
  const context = await policyContext(path, sha), directory = await nonceDirectory(context.operation.operationId)
  const receipt = await stored(directory, 'receipt.json'), intent = await stored(directory, 'intent.json')
  for (const value of [receipt, intent]) if (value) check(value.operationSha256 === sha, 'LIVE_OPERATION_CONFLICT')
  if (receipt) return { ...receipt, readOnly: true }
  if (!intent) return { state: 'not_issued', operationId: context.operation.operationId, readOnly: true }
  const { original } = await classes(context, false)
  const before = [], after = []
  for (const module of context.manifest.profile.modules) for (const method of module.methods) {
    const value = Object.getOwnPropertyDescriptor(original[module.class].prototype, method.method)?.value
    before.push(matches(value, method.before)); after.push(matches(value, method.after))
  }
  return { state: after.every(Boolean) ? 'applied_observed' : before.every(Boolean) ? 'not_applied_observed' : 'unconfirmed',
    operationId: context.operation.operationId, operationSha256: sha, readOnly: true, originalResultUnknown: true }
}

export async function commitPreparedPolicy(directory, intent, transaction) {
  await saveExclusive(join(directory, 'intent.json'), intent)
  let actual
  try { actual = transaction.commit() }
  catch (error) {
    await saveExclusive(join(directory, 'receipt.json'), { ...intent, schema: 'bellteam.live-delivery-receipt.v1',
      state: 'rejected_before_commit', code: /^LIVE_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'LIVE_COMMIT_FAILED' })
    throw error
  }
  const receipt = { ...intent, schema: 'bellteam.live-delivery-receipt.v1', state: 'applied',
    appliedAt: new Date().toISOString(), methods: actual, ownerReplacement: false, selectorChanged: false }
  // A failed receipt leaves intent and the real descriptors; never roll back later calls.
  await saveExclusive(join(directory, 'receipt.json'), receipt)
  return receipt
}

export function applyLiveDeliveryPolicy(path, sha) {
  if (inFlight.has(path)) {
    check(inFlight.get(path).sha === sha, 'LIVE_OPERATION_CONFLICT')
    return inFlight.get(path).promise
  }
  const promise = (async () => {
    const context = await policyContext(path, sha), directory = await nonceDirectory(context.operation.operationId)
    if (await stored(directory, 'intent.json')) return inspectLiveDeliveryPolicy(path, sha)
    const loaded = await classes(context)
    const transaction = prepareDescriptorChanges(context.manifest.profile, loaded.original, loaded.repaired)
    const intent = { schema: 'bellteam.live-delivery-intent.v1', operationId: context.operation.operationId,
      operationSha256: sha, policy: context.operation.policy, target: context.operation.target, at: new Date().toISOString() }
    return commitPreparedPolicy(directory, intent, transaction)
  })()
  inFlight.set(path, { sha, promise })
  void promise.finally(() => { if (inFlight.get(path)?.promise === promise) inFlight.delete(path) }).catch(() => {})
  return promise
}
