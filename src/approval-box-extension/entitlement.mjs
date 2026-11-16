// Approval Box extension F6: entitlement from Approval Box GET /v1/me (contract R4, Bready; api v0.37). Pure.
// Owner 2026-11-15 (decision d): the extension is usable exactly when Approval Box is usable for that account: trial and billing off are entitled.
// The gate reads only `entitled`. Unknown never locks (guards.unknown-is-not-danger): the caller keeps the last known result.
const out = (state, entitled, me, now) => ({ product: 'approval-box-extension', entitled, state, validUntil: me?.expires_at ?? null, store: me?.store ?? null, checkedAt: new Date(now).toISOString() })

// me: the /v1/me body or null (unreachable / 5xx) ; reachable: false when Approval Box could not be read ; credential: false when no session or 401/403.
export function entitlementFrom(me, { now = Date.now(), reachable = true, credential = true, previous = null } = {}) {
  if (!credential) return out('none', false, null, now)
  if (!reachable) return previous ?? out('unknown', true, null, now) // never known: true, nothing can be read then anyway
  if (me?.billing === 'off') return out('paid', true, me, now)
  const future = me?.expires_at && Date.parse(me.expires_at) > now
  // plan active with no expires_at is the billing-exempt account (api v0.39 /me omits expires_at and store for it): usable, nothing to expire.
  if (me?.plan === 'active') return future || !me.expires_at ? out('paid', true, me, now) : out('unknown', previous?.entitled ?? true, me, now)
  if (me?.plan === 'expired') return future ? out('revoked', false, me, now) : out('expired', false, me, now)
  if (me?.plan === 'trial') return out('trial', true, me, now)
  return out('none', false, me, now)
}

// Cache: a positive result for 5 minutes, a negative one for 1 minute (a fresh purchase shows quickly).
// shortcut: fixed windows, shorten if refunds must bite faster.
export const cacheMillis = result => (result.entitled ? 5 : 1) * 60_000
