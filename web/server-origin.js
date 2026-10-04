export function supportsServerTransport(address) {
  let url
  try { url = new URL(address) } catch { return false }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.local') || host === '::1') return true
  if (host.includes(':')) return /^(?:fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/u.test(host)
  const octets = host.split('.').map(Number)
  if (octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 169 && octets[1] === 254)
  }
  return !host.includes('.') && !/^\d+$/u.test(host)
}
