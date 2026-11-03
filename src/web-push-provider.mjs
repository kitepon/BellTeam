import { Resolver } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import webPush from 'web-push'
import { validateWebPushEndpoint, webPushError } from './usage/web-push-schema.mjs'

const excluded = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) excluded.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20]]) {
  excluded.addSubnet(address, prefix, 'ipv6')
}

// Conservatively exclude special-purpose ranges; only fixed push vendors use this lookup.
export function isPublicWebPushAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false
  const family = isIP(address)
  return family === 4 ? !excluded.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6')
}

export class WebPushProvider {
  constructor({ vapid, request = httpsRequest, resolverFactory = () => new Resolver(), timeoutMs = 15000 }) {
    this.vapid = vapid
    this.request = request
    this.resolverFactory = resolverFactory
    this.timeoutMs = timeoutMs
  }

  async send(subscription, payload) {
    const started = Date.now()
    const url = validateWebPushEndpoint(subscription.endpoint)
    const resolver = this.resolverFactory()
    let timedOut = false, req, socket
    const timeout = () => webPushError('WEB_PUSH_TIMEOUT', 503, req ? 'unknown' : 'not_accepted')
    const timer = setTimeout(() => {
      timedOut = true
      resolver.cancel()
      req?.destroy(timeout())
      socket?.destroy()
    }, this.timeoutMs)
    try {
      let details
      try {
        details = webPush.generateRequestDetails(subscription, payload, {
          vapidDetails: this.vapid, TTL: 86400, urgency: 'normal', contentEncoding: 'aes128gcm',
        })
      } catch { throw webPushError('WEB_PUSH_ENCRYPTION_FAILED', 503) }
      if (timedOut || Date.now() - started >= this.timeoutMs) throw timeout()
      const results = await Promise.allSettled([resolver.resolve4(url.hostname), resolver.resolve6(url.hostname)])
      if (timedOut || Date.now() - started >= this.timeoutMs) throw timeout()
      const addresses = []
      for (const result of results) {
        if (result.status === 'fulfilled') addresses.push(...result.value)
        else if (!['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) throw webPushError('WEB_PUSH_DNS_FAILED', 503)
      }
      if (!addresses.length || addresses.some(address => !isPublicWebPushAddress(address))) throw webPushError('WEB_PUSH_DESTINATION_FORBIDDEN')
      const address = addresses[0], family = isIP(address)
      return await new Promise((resolve, reject) => {
        let requestClosed = false, socketClosed = true, responseEnded = false, status, failure
        const finish = () => {
          if (!requestClosed || !socketClosed) return
          if (timedOut) return reject(timeout())
          if (failure || !responseEnded) return reject(failure ?? webPushError('WEB_PUSH_CONNECTION_FAILED', 503, 'unknown'))
          if (status >= 200 && status < 300) return resolve({ accepted: true })
          reject(webPushError([404, 410].includes(status) ? 'WEB_PUSH_EXPIRED'
            : [401, 403].includes(status) ? 'WEB_PUSH_AUTH_FAILED' : 'WEB_PUSH_SERVICE_FAILED', 503, 'unknown'))
        }
        const failed = () => {
          if (!responseEnded) failure = webPushError('WEB_PUSH_CONNECTION_FAILED', 503, 'unknown')
          req.destroy()
          socket?.destroy()
        }
        if (timedOut || Date.now() - started >= this.timeoutMs) { reject(timeout()); return }
        try {
          req = this.request({ protocol: 'https:', hostname: url.hostname, port: 443,
            path: `${url.pathname}${url.search}`, method: 'POST', headers: details.headers,
            servername: url.hostname, rejectUnauthorized: true, agent: false, family, autoSelectFamily: false,
            lookup: (hostname, options, callback) => {
              if (hostname !== url.hostname) return callback(webPushError('WEB_PUSH_DESTINATION_FORBIDDEN'))
              queueMicrotask(() => options.all ? callback(null, [{ address, family }]) : callback(null, address, family))
            },
          })
        } catch { reject(webPushError('WEB_PUSH_CONNECTION_FAILED', 503)); return }
        req.once('socket', opened => {
          socket = opened; socketClosed = opened.closed === true
          opened.once('close', () => { socketClosed = true; finish() })
          if (timedOut) opened.destroy()
        })
        req.on('error', failed)
        req.once('close', () => { requestClosed = true; finish() })
        req.once('response', response => {
          status = response.statusCode
          response.on('error', failed)
          response.once('aborted', failed)
          response.once('end', () => { responseEnded = true; socket?.destroy(); finish() })
          response.resume()
        })
        req.end(details.body)
      })
    } finally {
      clearTimeout(timer)
    }
  }
}
