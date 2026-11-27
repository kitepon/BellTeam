// P8 Owner QR notice (docs/architecture/modules/approval-box-extension/seats-on-hosted-daemon.md section 10).
// Contracted ports only: the module's own pairing object (start / waiting view) and the messenger port (one image to the Owner). The waiting view's secrets go only into the Owner's own conversation.
import { deflateSync } from 'node:zlib'
import qrcode from 'qrcode-generator'

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

// A black-and-white PNG of the QR code for `text` (error correction M, 4-module quiet zone). Throws when the text does not fit.
export function qrPng(text, { scale = 6, quiet = 4 } = {}) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make()
  const count = qr.getModuleCount(), size = (count + quiet * 2) * scale
  const raw = Buffer.alloc((size + 1) * size, 255)
  for (let y = 0; y < size; y++) {
    const row = y * (size + 1), r = Math.floor(y / scale) - quiet
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const c = Math.floor(x / scale) - quiet
      if (r >= 0 && c >= 0 && r < count && c < count && qr.isDark(r, c)) raw[row + 1 + x] = 0
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8 // 8-bit grayscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// "12/5 00:00": the date is always shown, the pairing lives days (the connector's expiresAt), not minutes.
const clock = iso => { const at = Date.parse(iso); if (!Number.isFinite(at)) return null; const jst = new Date(at + 9 * 3_600_000).toISOString(); return `${Number(jst.slice(5, 7))}/${Number(jst.slice(8, 10))} ${jst.slice(11, 16)}` }

export function ownerMessage(view) {
  const until = clock(view.expiresAt)
  return [
    '決裁箱の接続の QR です。この画像を、iPhone の決裁箱で読んでください。',
    '1. 決裁箱で「接続」→「AIをつなぐ」→「QRコードを読む」を開く。',
    '2. この画像を読み、「つなぐ」を押す。',
    `QR が読めない時は、「コードを確認」に ${view.code} を入れ、次の画面の「PCに16文字のコードが出ている時は、ここに入力してください。」に ${view.typedSecret} を入れてください。`,
    ...(until ? [`${until}まで有効です（JST）。`] : []),
  ].join('\n')
}

// pairing: the module's P3 object ({start()}); post({message, image}): the messenger port to the Owner's conversation.
export function createSeatLinkQr({ pairing, post }) {
  return {
    async show() {
      let view
      try { view = await pairing.start() } catch { return { outcome: 'not_started', reason: 'unavailable' } }
      if (view.state === 'linked') return { outcome: 'linked' }
      if (view.state !== 'waiting' || !view.qrText || !view.code || !view.typedSecret) return { outcome: 'not_started', reason: view.reason ?? view.state }
      let png
      try { png = qrPng(view.qrText) } catch { return { outcome: 'not_started', reason: 'qr_too_long' } }
      try { await post({ message: ownerMessage(view), image: { mime: 'image/png', data: png.toString('base64') } }) } catch { return { outcome: 'post_failed' } }
      return { outcome: 'posted', ...(view.expiresAt ? { expiresAt: view.expiresAt } : {}) }
    },
  }
}
