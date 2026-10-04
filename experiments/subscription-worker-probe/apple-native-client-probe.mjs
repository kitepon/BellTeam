import fixtures from './apple-test-fixtures.json' with { type: 'json' }
import { importAppleSigningKey, createAppleJWT } from '../../services/subscriptions/apple-jwt.mjs'

let verifier
let signingKey

export async function appleNativeClientProbe() {
  const { SignedDataVerifier } = await import('@apple/app-store-server-library/dist/jws_verification.js')
  verifier ??= new SignedDataVerifier([Buffer.from(fixtures.rootCertificate, 'base64')], false, 'Sandbox', 'com.example')
  signingKey ??= await importAppleSigningKey(fixtures.signingKey)
  const submitted = await verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  await createAppleJWT(signingKey, { keyId: 'probe', issuerId: 'probe', bundleId: 'com.example' })
  const latest = await verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  const renewal = await verifier.verifyAndDecodeRenewalInfo(fixtures.signedRenewal)
  return {
    verified: submitted.environment === 'Sandbox' && latest.environment === 'Sandbox' && renewal.environment === 'Sandbox',
    tokenSignatures: 1,
    signedPayloadVerifications: 3,
    libraryVersion: '3.1.0',
  }
}
