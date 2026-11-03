const failure = (code, status) => Object.assign(new Error(code), { code, status })

export function createWebPushOrigin({ settings }) {
  return request => {
    let trusted
    try {
      trusted = new URL(settings.configuration('cloudflare').publicUrl)
      if (trusted.protocol !== 'https:' || trusted.username || trusted.password || Buffer.byteLength(trusted.origin) > 2048) throw new Error()
    } catch { throw failure('WEB_PUSH_ORIGIN_UNAVAILABLE', 503) }
    const origin = request.headers.origin
    const site = request.headers['sec-fetch-site']
    const copies = (request.rawHeaders ?? []).filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin').length
    if (typeof origin !== 'string' || origin !== origin.trim() || /[\u0000-\u0020\u007f,]/u.test(origin) || !/^https:\/\/[^/\\?#]+$/u.test(origin)
      || copies > 1 || site !== undefined && site !== 'same-origin') throw failure('WEB_PUSH_ORIGIN_FORBIDDEN', 403)
    let supplied
    try { supplied = new URL(origin) } catch { throw failure('WEB_PUSH_ORIGIN_FORBIDDEN', 403) }
    if (supplied.origin !== trusted.origin || supplied.username || supplied.password
      || supplied.pathname !== '/' || supplied.search || supplied.hash) throw failure('WEB_PUSH_ORIGIN_FORBIDDEN', 403)
    return trusted.origin
  }
}
