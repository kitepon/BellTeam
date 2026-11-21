// Reply to a chosen message (docs/architecture/modules/conversation/reply.md).
// The quote is a snapshot saved once on the new row; nothing resolves the id again at read time.
export const QUOTE_MAX = 300
export const REPLY_TO_MAX = 200

export const validReplyTo = value => typeof value === 'string' && value.length > 0
  && value.length <= REPLY_TO_MAX && !value.includes('\0')

// The Owner's post is the only writer; the id must be valid before any row is saved.
export function requireReplyTo(value) {
  if (!validReplyTo(value)) throw Object.assign(new Error('REPLY_TO_INVALID'), { code: 'REPLY_TO_INVALID', status: 400 })
  return value
}

export const QUOTE_INPUT_MAX = 10000

// reply_quote: the selected part. text is what the client selected; start is an optional code-point offset hint.
export const validReplyQuote = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => key === 'text' || key === 'start')
  && typeof value.text === 'string' && value.text.length <= QUOTE_INPUT_MAX && /\S/u.test(value.text)
  && (value.start === undefined || (Number.isSafeInteger(value.start) && value.start >= 0))

export function requireReplyQuote(value) {
  if (!validReplyQuote(value)) throw Object.assign(new Error('REPLY_QUOTE_INVALID'), { code: 'REPLY_QUOTE_INVALID', status: 400 })
  return value
}

// Code-point range of the selection in the original's saved text: the hint when it matches exactly, else the first occurrence.
export function locateQuote(original, quote) {
  const text = [...String(original ?? '')], needle = [...quote.text]
  const at = index => needle.every((char, offset) => text[index + offset] === char)
  if (quote.start !== undefined && at(quote.start)) return { start: quote.start, end: quote.start + needle.length }
  for (let index = 0; index + needle.length <= text.length; index++) if (at(index)) return { start: index, end: index + needle.length }
  return null
}

// source: { sender: {id, name}, at, text, image } read from the same conversation, or null when it cannot be used.
// quote (optional reply_quote): the part the Owner selected; its text becomes reply_to.text.
export function snapshotReply(id, source, quote = null) {
  const lines = value => [...String(value).replace(/\r\n?/gu, '\n')]
  const cut = chars => ({ text: chars.slice(0, QUOTE_MAX).join(''), ...(chars.length > QUOTE_MAX ? { truncated: true } : {}) })
  if (!source) return quote ? { id, available: false, part: true, ...cut(lines(quote.text)) } : { id, available: false }
  const range = quote ? locateQuote(source.text, quote) : null
  return { id, available: true, sender: { id: source.sender.id, name: source.sender.name ?? source.sender.id }, at: source.at,
    ...cut(lines(quote ? quote.text : source.text ?? '')), ...(source.image === true && !quote ? { image: true } : {}),
    ...(quote ? { part: true, ...(range ? { range } : {}) } : {}) }
}

// a471-quote-plain-server: the quote line is drawn as served, so the server removes Markdown marks on every read (old replies too).
// The saved snapshot and what the Bot reads stay as saved; `range` refers to the original's own text and is unchanged.
// shortcut: line-based marks only, no nested lists or HTML, upgrade if the Owner's messages show other marks.
// shortcut: a lone `*` right before a word is taken as a cut italic mark (a footnote star at a word start is lost), upgrade if that shows up.
export function plainQuoteText(text) {
  return String(text)
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gmu, '\0')
    .replace(/^\0\n?/gmu, '')
    .replace(/!\[([^\]\n]*)\]\([^)\n]*\)/gu, '$1')
    .replace(/\[([^\]\n]+)\]\([^)\n]*\)/gu, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gmu, '')
    .replace(/^(?:[ \t]*>[ \t]?)+/gmu, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gmu, '')
    .replace(/`+([^`\n]+)`+/gu, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/gu, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/gu, '$1')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/gu, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/gu, '$1')
    // a selection can cut a span: an opening or closing mark left without its partner (a471-quote-cut-marks)
    .replace(/(?<!\w)(?:\*\*|~~|__)(?=\S)|(?<=\S)(?:\*\*|~~|__)(?!\w)/gu, '')
    .replace(/(?<![\w*])\*(?=[^\s*])/gu, '')
}

export function jst(iso) {
  return `${new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ')} JST`
}

// The block the Bot reads between the "from" line and the message. Built only from the saved snapshot, so a re-dispatch repeats it.
export function replyNotice(replyTo) {
  if (!replyTo) return ''
  const body = replyTo.text === '' && replyTo.image ? '（画像）' : `${replyTo.text}${replyTo.truncated ? '…' : ''}`
  const quoted = body.split('\n').map(line => `> ${line}`).join('\n')
  if (!replyTo.available) return replyTo.part
    ? `これは過去の発言の一部への返信ですが、元の発言は見つかりませんでした（メッセージID: ${replyTo.id}）。\n引用した部分（選択された文章そのまま）:\n${quoted}\n\n`
    : `これは過去の発言への返信ですが、元の発言は見つかりませんでした（メッセージID: ${replyTo.id}）。\n\n`
  const name = replyTo.sender.id === 'user' ? 'オーナー' : replyTo.sender.name
  return `これは次の発言${replyTo.part ? 'の一部' : ''}への返信です。\n返信先: 「${name}」 ${jst(replyTo.at)}（メッセージID: ${replyTo.id}）\n${replyTo.part ? '引用した部分:\n' : ''}${quoted}\n\n`
}
