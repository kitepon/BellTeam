// 直接接続では、同じマシンとLANのHTTPを使える。
export function isLocalHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || /^(?:fc|fd)[\da-f]{2}:/u.test(host) || /^fe[89ab][\da-f]:/u.test(host)) return true
  const parts = host.split('.').map(Number)
  if (/^\d+\.\d+\.\d+\.\d+$/u.test(host) && parts.every(n => n >= 0 && n <= 255)) {
    const [a, b] = parts
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return /^[a-z][a-z\d-]*$/u.test(host)
}

export function isSupportedServerURL(value) {
  let url
  try { url = value instanceof URL ? value : new URL(value) } catch { return false }
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHostname(url.hostname)))
}
