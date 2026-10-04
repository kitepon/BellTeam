import assert from 'node:assert/strict'
import { sign, X509Certificate } from 'node:crypto'
import test from 'node:test'
import { SignedDataVerifier } from '@apple/app-store-server-library'
import fixtures from './fixtures/subscriptions/certificates.json' with { type: 'json' }
import invalidCertificates from './fixtures/subscriptions/native-invalid-certificates.json' with { type: 'json' }
import appleFixtures from '../experiments/subscription-worker-probe/apple-test-fixtures.json' with { type: 'json' }
import roots from '../services/subscriptions/apple-roots.json' with { type: 'json' }
import { NativeSignedDataVerifier, certificateExtensionOIDs } from '../experiments/subscription-worker-probe/native-verifier.mjs'

const trustedRoots = [Buffer.from(fixtures.rootCertificate, 'base64')]
const native = new NativeSignedDataVerifier(trustedRoots, 'Sandbox', 'com.example')
const official = new SignedDataVerifier(trustedRoots, false, 'Sandbox', 'com.example')
const payload = { bundleId: 'com.example', environment: 'Sandbox', signedDate: fixtures.signedDate }

function signed(body = payload, x5c = fixtures.x5c, alg = 'ES256') {
  const header = Buffer.from(JSON.stringify({ alg, x5c })).toString('base64url')
  const message = `${header}.${Buffer.from(JSON.stringify(body)).toString('base64url')}`
  return `${message}.${sign('sha256', Buffer.from(message), { key: fixtures.signingKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

test('Apple公式の公開試験取引・更新情報を両方の検証器が同じ内容として認める', async () => {
  const testRoots = [Buffer.from(appleFixtures.rootCertificate, 'base64')]
  const nativeApple = new NativeSignedDataVerifier(testRoots, 'Sandbox', 'com.example')
  const officialApple = new SignedDataVerifier(testRoots, false, 'Sandbox', 'com.example')
  assert.deepEqual(nativeApple.verifyAndDecodeTransaction(appleFixtures.signedTransaction), await officialApple.verifyAndDecodeTransaction(appleFixtures.signedTransaction))
  assert.deepEqual(nativeApple.verifyAndDecodeRenewalInfo(appleFixtures.signedRenewal), await officialApple.verifyAndDecodeRenewalInfo(appleFixtures.signedRenewal))
})

test('署名改変・別アプリ・別環境・必須の証明書数・型の異常を拒否する', async () => {
  const valid = signed()
  const parts = valid.split('.')
  parts[1] = Buffer.from(JSON.stringify({ ...payload, environment: 'Production' })).toString('base64url')
  for (const jws of [
    parts.join('.'), signed({ ...payload, bundleId: 'other' }), signed({ ...payload, environment: 'Production' }),
    signed(payload, fixtures.x5c.slice(0, 2)), signed({ ...payload, signedDate: 'today' }),
    signed(payload, fixtures.x5c, 'none'), `${valid.slice(0, -12)}invalid`,
  ]) {
    assert.throws(() => native.verifyAndDecodeTransaction(jws))
    await assert.rejects(() => official.verifyAndDecodeTransaction(jws))
  }
})

test('添付ルートを信頼せず、証明書の差し替えと期限外を拒否する', async () => {
  const appleNative = new NativeSignedDataVerifier(roots.certificates.map(c => Buffer.from(c.der, 'base64')), 'Sandbox', 'com.example')
  assert.throws(() => appleNative.verifyAndDecodeTransaction(signed()))
  for (const jws of [
    signed(payload, [fixtures.x5c[0], appleFixtures.rootCertificate, fixtures.x5c[2]]),
    signed({ ...payload, signedDate: Date.parse(new X509Certificate(trustedRoots[0]).validTo) + 60001 }),
    signed({ ...payload, signedDate: Date.parse(new X509Certificate(trustedRoots[0]).validFrom) - 60001 }),
  ]) {
    assert.throws(() => native.verifyAndDecodeTransaction(jws))
    await assert.rejects(() => official.verifyAndDecodeTransaction(jws))
  }
})

test('用途OIDは証明書の拡張だけから読み、一般名に含むOID文字列は認めない', async () => {
  assert.ok(certificateExtensionOIDs(Buffer.from(fixtures.x5c[0], 'base64')).includes('1.2.840.113635.100.6.11.1'))
  assert.ok(certificateExtensionOIDs(Buffer.from(fixtures.x5c[1], 'base64')).includes('1.2.840.113635.100.6.2.1'))
  assert.ok(!certificateExtensionOIDs(trustedRoots[0]).includes('1.2.840.113635.100.6.11.1'))
  assert.throws(() => certificateExtensionOIDs(Buffer.from('1.2.840.113635.100.6.11.1')))
  assert.ok(new X509Certificate(Buffer.from(invalidCertificates.missingLeafPurpose,'base64')).subject.includes('1.2.840.113635.100.6.11.1'))
  for (const chain of [
    [invalidCertificates.missingLeafPurpose, fixtures.x5c[1], fixtures.x5c[2]],
    [fixtures.x5c[0], invalidCertificates.missingIntermediatePurpose, fixtures.x5c[2]],
  ]) {
    const jws = signed(payload, chain)
    assert.throws(() => native.verifyAndDecodeTransaction(jws), /Appleの証明書用途/)
    await assert.rejects(() => official.verifyAndDecodeTransaction(jws))
  }
})

test('中間証明書のCA属性を確認し、正しい署名でもCAでなければ拒否する', async () => {
  const jws = signed(payload, [fixtures.x5c[0], invalidCertificates.intermediateNotCA, fixtures.x5c[2]])
  assert.throws(() => native.verifyAndDecodeTransaction(jws), /証明書チェーン/)
  await assert.rejects(() => official.verifyAndDecodeTransaction(jws))
})
