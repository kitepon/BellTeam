import { DurableObject } from 'cloudflare:workers'
import { appleLibraryProbe } from './apple-library-probe.mjs'

// 公開試験データだけを検証する。ストレージ・アラーム・実際のAppleキーは使わない。
export class SubscriptionVerificationProbe extends DurableObject {
  async fetch() {
    return Response.json(await appleLibraryProbe())
  }
}
