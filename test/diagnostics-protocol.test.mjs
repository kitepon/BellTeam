import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIAGNOSTICS_STATE_COMPATIBILITY, assertDiagnosticsStateCompatibility, diagnosticsWireError,
  validateDiagnosticsRequest, validateDiagnosticsControl, validateDiagnosticsControlResult, validateDiagnosticsReady, validateDiagnosticsRow } from '../src/diagnostics-protocol.mjs'

test('control and ready use exact generation, actual state compatibility and fixed result shapes', () => {
  validateDiagnosticsControl('initialize', { generation: 'builtin:fixture', mode: 'restore' })
  validateDiagnosticsControl('quiesce', {})
  validateDiagnosticsControlResult('initialize', { stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY })
  validateDiagnosticsControlResult('quiesce', { quiesced: false })
  validateDiagnosticsReady({ versionId: null, protocolVersion: 1, stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY })
  for (const params of [{ generation: 'bad value', mode: 'restore' }, { generation: 'ok', mode: 'migrate' },
    { generation: 'ok', mode: 'restore', file: '/arbitrary' }]) assert.throws(() => validateDiagnosticsControl('initialize', params))
  assert.throws(() => validateDiagnosticsControl('save', {}))
  assert.throws(() => validateDiagnosticsControl('exit', { force: true }))
  assert.throws(() => assertDiagnosticsStateCompatibility({ ...DIAGNOSTICS_STATE_COMPATIBILITY, schema: 1 }))
  assert.throws(() => validateDiagnosticsControlResult('resume', { resumed: false }))
  assert.throws(() => validateDiagnosticsReady({ versionId: 'builtin', protocolVersion: 1, stateCompatibility: DIAGNOSTICS_STATE_COMPATIBILITY }))
})

test('row DTO preserves existing metadata and rejects malformed fixed identity/count/status', () => {
  const row = { fingerprint: 'a'.repeat(64), severity: 'warn', message_template: 'fixture', module: 'server',
    category: 'SERVER_HTTP_503', occurrence_count: 1, last_seen: '2026-11-03T00:00:00.000Z', status: 'open',
    diagnostic_log: 'original', diagnostic_context: { existing_context: 'preserved' } }
  assert.equal(validateDiagnosticsRow(row), true)
  for (const override of [{ fingerprint: 'private' }, { occurrence_count: 0 }, { status: 'deleted' }, { last_seen: 'invalid' }])
    assert.throws(() => validateDiagnosticsRow({ ...row, ...override }))
})

test('wire failure maps only existing semantic codes and never reflects arbitrary error text', () => {
  assert.deepEqual(diagnosticsWireError(new Error('DIAGNOSTIC_NOT_FOUND'), 'unknown'),
    { code: 'DIAGNOSTIC_NOT_FOUND', status: 404, outcome: 'unknown' })
  assert.deepEqual(diagnosticsWireError(Object.assign(new Error('private-path-body'), { code: 'EIO' }), 'unknown'),
    { code: 'DIAGNOSTICS_OPERATION_FAILED', status: 503, outcome: 'unknown' })
})

test('optional undefined management fields retain the existing local facade call shape', () => {
  const context = { generation: 'fixture' }, fingerprint = 'a'.repeat(64)
  validateDiagnosticsRequest('setStatus', { fingerprint, status: 'resolved', note: undefined }, context)
  validateDiagnosticsRequest('updateInvestigation', { fingerprint, status: undefined, note: undefined }, context)
  assert.throws(() => validateDiagnosticsRequest('setNote', { fingerprint, note: undefined }, context))
})
