import fixtures from './apple-test-fixtures.json' with { type: 'json' }

let verifier
let client

export async function appleLibraryProbe() {
  // 依存ライブラリの初期化に乱数処理があるため、リクエスト中に読み込む。
  const { SignedDataVerifier, AppStoreServerAPIClient, Environment } = await import('@apple/app-store-server-library')
  verifier ??= new SignedDataVerifier([Buffer.from(fixtures.rootCertificate, 'base64')], false, Environment.SANDBOX, 'com.example')
  if (!client) {
    // AppleへのHTTP通信だけを試験応答へ置き換え、公開APIの署名と応答解析は実行する。
    class ProbeClient extends AppStoreServerAPIClient {
      async makeFetchRequest() {
        return Response.json({ environment: 'Sandbox', bundleId: 'com.example', data: [] })
      }
    }
    client = new ProbeClient(fixtures.signingKey, 'probe', 'probe', 'com.example', Environment.SANDBOX)
  }
  const submitted = await verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  await client.getAllSubscriptionStatuses('probe')
  const latest = await verifier.verifyAndDecodeTransaction(fixtures.signedTransaction)
  const renewal = await verifier.verifyAndDecodeRenewalInfo(fixtures.signedRenewal)
  return {
    verified: submitted.environment === 'Sandbox' && latest.environment === 'Sandbox' && renewal.environment === 'Sandbox',
    tokenSignatures: 1,
    signedPayloadVerifications: 3,
    libraryVersion: '3.1.0',
  }
}
