import fixtures from './apple-test-fixtures.json' with { type: 'json' }
import { NativeSignedDataVerifier } from './native-verifier.mjs'
import { importAppleSigningKey, createAppleJWT } from '../../services/subscriptions/apple-jwt.mjs'

const verifier = new NativeSignedDataVerifier([Buffer.from(fixtures.rootCertificate, 'base64')], 'Sandbox', 'com.example')
let signingKey

export async function appleNativeVerifierProbe() {
  signingKey ??= await importAppleSigningKey(fixtures.signingKey)
  const submitted = verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  await createAppleJWT(signingKey, { keyId: 'probe', issuerId: 'probe', bundleId: 'com.example' })
  const latest = verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  const renewal = verifier.verifyAndDecodeRenewalInfo(fixtures.signedRenewal)
  return {
    verified: submitted.environment === 'Sandbox' && latest.environment === 'Sandbox' && renewal.environment === 'Sandbox',
    tokenSignatures: 1,
    signedPayloadVerifications: 3,
    verificationEngine: 'Node X509Certificate + ASN1js + jsonwebtoken',
  }
}
