import test from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateCenter } from '../src/update-center.mjs'
import { createModuleUpdateAdapters } from '../src/update-module-adapters.mjs'

test('explicit builtin current uses the real parent source; release, unknown and explicit metadata stay unchanged', () => {
  const imageSource = 'a'.repeat(40), explicitSource = 'b'.repeat(40), release = 'c'.repeat(64)
  const builtin = source => ({ version: source, sourceCommit: source, digest: null, origin: 'builtin' })
  for (const [state, expected] of [
    [{ currentVersionId: null, currentTarget: 'builtin' }, builtin(imageSource)],
    [{ currentVersionId: null, currentTarget: 'builtin', builtinSourceCommit: explicitSource }, builtin(explicitSource)],
    [{ currentVersionId: null, currentTarget: 'builtin', builtinSourceCommit: 'invalid' }, null],
    [{ currentVersionId: null, currentTarget: 'unknown' }, null],
    [{ currentTarget: 'builtin' }, null],
    [{ currentVersionId: null }, null],
    [{ currentVersionId: release, currentTarget: 'release' }, { version: release, sourceCommit: null, digest: `sha256:${release}`, origin: 'release' }],
  ]) {
    const usage = { snapshot: () => ({ ...state, available: true }) }
    const center = createUpdateCenter({ builtinSourceCommit: imageSource, usage })
    const component = center.snapshot().components.find(value => value.id === 'usage')
    const adapter = createModuleUpdateAdapters({ builtinSourceCommit: imageSource, usage, gateway: () => null }).usage
    assert.deepEqual(component.current, expected, JSON.stringify(state))
    assert.deepEqual(adapter.current(), expected, JSON.stringify(state))
    assert.equal(component.availability.available, true)
    assert.equal(component.capability.supported, false)
    assert.equal(component.published, null)
  }
  const usage = { snapshot: () => ({ currentVersionId: null, currentTarget: 'builtin', available: true }) }
  assert.equal(createUpdateCenter({ usage }).snapshot().components.find(value => value.id === 'usage').current, null)
  assert.equal(createModuleUpdateAdapters({ usage, gateway: () => null }).usage.current(), null)
})
