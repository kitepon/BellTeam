import { X509Certificate } from 'node:crypto'
import { fromBER, Sequence, ObjectIdentifier } from 'asn1js'
import jsonwebtoken from 'jsonwebtoken'
import { JWSTransactionDecodedPayloadValidator } from '@apple/app-store-server-library/dist/models/JWSTransactionDecodedPayload.js'
import { JWSRenewalInfoDecodedPayloadValidator } from '@apple/app-store-server-library/dist/models/JWSRenewalInfoDecodedPayload.js'

// CPU試験用。Apple公式のオフライン検証と同じチェーン・用途・期限を確認する。
// 暗号処理はNodeのX509Certificateと、公式ライブラリも使うjsonwebtokenへ渡す。
export class NativeVerificationError extends Error {}

export function certificateExtensionOIDs(der) {
  const parsed = fromBER(der)
  if (parsed.offset !== der.byteLength || !(parsed.result instanceof Sequence)) throw new NativeVerificationError('証明書のASN.1形式が一致しません。')
  const tbs = parsed.result.valueBlock.value[0]
  if (!(tbs instanceof Sequence)) throw new NativeVerificationError('証明書の署名対象がありません。')
  const wrapper = tbs.valueBlock.value.find(item => item.idBlock.tagClass === 3 && item.idBlock.tagNumber === 3)
  const extensions = wrapper?.valueBlock.value?.[0]
  if (!(extensions instanceof Sequence)) return []
  return extensions.valueBlock.value.map(extension => {
    const oid = extension.valueBlock.value?.[0]
    if (!(extension instanceof Sequence) || !(oid instanceof ObjectIdentifier)) throw new NativeVerificationError('証明書の拡張形式が一致しません。')
    return oid.valueBlock.toString()
  })
}

export class NativeSignedDataVerifier {
  constructor(rootCertificates, environment, bundleId) {
    this.roots = rootCertificates.map(der => new X509Certificate(der))
    this.environment = environment
    this.bundleId = bundleId
    this.transactionValidator = new JWSTransactionDecodedPayloadValidator()
    this.renewalValidator = new JWSRenewalInfoDecodedPayloadValidator()
  }

  verifyAndDecodeTransaction(jws) {
    const payload = this.verify(jws, this.transactionValidator)
    if (payload.bundleId !== this.bundleId) throw new NativeVerificationError('アプリが一致しません。')
    return payload
  }

  verifyAndDecodeRenewalInfo(jws) {
    return this.verify(jws, this.renewalValidator)
  }

  verify(jws, validator) {
    // ここだけが外部の署名データを解析する境界。解析・暗号ライブラリの拒否を明示する。
    try {
      const decoded = jsonwebtoken.decode(jws, { complete: true })
      if (!decoded || decoded.header.alg !== 'ES256' || !Array.isArray(decoded.header.x5c) || decoded.header.x5c.length !== 3) throw new NativeVerificationError('署名ヘッダーが一致しません。')
      const payload = decoded.payload
      if (!payload || typeof payload !== 'object' || !validator.validate(payload)) throw new NativeVerificationError('署名付きデータの形式が一致しません。')
      if (payload.environment !== this.environment) throw new NativeVerificationError('購入環境が一致しません。')
      if (payload.signedDate !== undefined && !Number.isFinite(payload.signedDate)) throw new NativeVerificationError('署名日時が一致しません。')
      const signedAt = payload.signedDate === undefined ? Date.now() : payload.signedDate
      const [leaf, intermediate] = decoded.header.x5c.slice(0, 2).map(encoded => new X509Certificate(Buffer.from(encoded, 'base64')))
      // JWSに添付されたルートを信頼せず、設定した信頼ルートだけで検証する。
      const root = this.roots.find(trusted => intermediate.issuer === trusted.subject && intermediate.verify(trusted.publicKey))
      if (!root || !intermediate.ca || leaf.issuer !== intermediate.subject || !leaf.verify(intermediate.publicKey)) throw new NativeVerificationError('証明書チェーンを確認できません。')
      if (!certificateExtensionOIDs(leaf.raw).includes('1.2.840.113635.100.6.11.1') || !certificateExtensionOIDs(intermediate.raw).includes('1.2.840.113635.100.6.2.1')) throw new NativeVerificationError('Appleの証明書用途を確認できません。')
      for (const certificate of [leaf, intermediate, root]) {
        if (Date.parse(certificate.validFrom) - 60000 > signedAt || Date.parse(certificate.validTo) + 60000 < signedAt) throw new NativeVerificationError('署名日時が証明書の有効期間外です。')
      }
      jsonwebtoken.verify(jws, leaf.publicKey, { algorithms: ['ES256'] })
      return payload
    } catch (error) {
      if (error instanceof NativeVerificationError) throw error
      throw new NativeVerificationError('証明書または署名を解析・確認できません。', { cause: error })
    }
  }
}
