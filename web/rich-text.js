import { linkifyHtml } from './chat-input.js?v=__ASSET_VERSION__'

// 本文をMarkdownとして描画する。対応: 見出し・引用・箇条書き（入れ子・番号・チェック）・表・コード（囲みと`行内`）・強調・打消し・[名前](URL)・裸のURL・区切り線。
export function richTextHtml(text = '') {
  return renderBlocks(String(text).replace(/\r\n?/gu, '\n').split('\n'))
}

const escapeHtml = value => String(value).replace(/[&<>'"]/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/u
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u
const indentOf = line => line.match(/^\s*/u)[0].length

function renderBlocks(lines) {
  const html = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i += 1; continue }
    const fence = line.match(/^\s*(```|~~~)\s*(\S*)/u)
    if (fence) {
      const body = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) { body.push(lines[i]); i += 1 }
      i += 1
      const language = fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ''
      html.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/u)
    if (heading) { html.push(`<h${heading[1].length}>${inlineHtml(heading[2])}</h${heading[1].length}>`); i += 1; continue }
    if (RULE.test(line)) { html.push('<hr>'); i += 1; continue }
    if (/^\s*>/u.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/u.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/u, '')); i += 1 }
      html.push(`<blockquote>${renderBlocks(body)}</blockquote>`)
      continue
    }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEPARATOR.test(lines[i + 1])) {
      const rows = []
      while (i < lines.length && lines[i].includes('|')) { rows.push(lines[i]); i += 1 }
      html.push(renderTable(rows))
      continue
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, i)
      html.push(list.html)
      i = list.next
      continue
    }
    const paragraph = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) { paragraph.push(lines[i].trim()); i += 1 }
    html.push(`<p>${paragraph.map(inlineHtml).join('<br>')}</p>`)
  }
  return html.join('')
}

function startsBlock(line) {
  return /^\s*(```|~~~|#{1,6}\s|>)/u.test(line) || LIST_ITEM.test(line) || RULE.test(line)
}

function renderList(lines, start) {
  const first = lines[start].match(LIST_ITEM)
  const indent = first[1].length
  const ordered = /\d/u.test(first[2])
  const items = []
  let i = start
  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM)
    if (match && match[1].length === indent && /\d/u.test(match[2]) === ordered) { items.push([match[3]]); i += 1; continue }
    const blank = !lines[i].trim()
    if (blank && i + 1 < lines.length && lines[i + 1].trim() && indentOf(lines[i + 1]) > indent) { items.at(-1).push(''); i += 1; continue }
    if (!blank && indentOf(lines[i]) > indent) { items.at(-1).push(lines[i].slice(Math.min(indent + 2, indentOf(lines[i])))); i += 1; continue }
    break
  }
  const body = items.map(item => {
    const task = item[0].match(/^\[([ xX])\]\s+(.*)$/u)
    if (task) item[0] = task[2]
    const inner = renderBlocks(item).replace(/^<p>([\s\S]*?)<\/p>/u, '$1')
    const box = task ? `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> ` : ''
    return `<li${task ? ' class="task"' : ''}>${box}${inner}</li>`
  }).join('')
  const tag = ordered ? 'ol' : 'ul'
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1
  const attrs = startNumber !== 1 ? ` start="${startNumber}"` : ''
  return { html: `<${tag}${attrs}>${body}</${tag}>`, next: i }
}

function splitCells(row) {
  return row.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '').split(/(?<!\\)\|/u).map(cell => cell.trim().replace(/\\\|/gu, '|'))
}

function renderTable(rows) {
  const header = splitCells(rows[0])
  const aligns = splitCells(rows[1]).map(cell => (/^:-+:$/u.test(cell) ? 'center' : /^-+:$/u.test(cell) ? 'right' : /^:-+$/u.test(cell) ? 'left' : ''))
  const style = index => (aligns[index] ? ` style="text-align:${aligns[index]}"` : '')
  const head = `<thead><tr>${header.map((cell, index) => `<th${style(index)}>${inlineHtml(cell)}</th>`).join('')}</tr></thead>`
  const body = rows.slice(2).map(row => `<tr>${splitCells(row).slice(0, header.length).map((cell, index) => `<td${style(index)}>${inlineHtml(cell)}</td>`).join('')}</tr>`).join('')
  return `<div class="table-scroll"><table>${head}${body ? `<tbody>${body}</tbody>` : ''}</table></div>`
}

// 行内: バックスラッシュ退避 → コード片 → [名前](URL)と裸のURL → 強調。退避した文字は私用領域の文字で包んで最後に戻す。
const HOLD = '\uE000'
function inlineHtml(text) {
  const held = []
  const protectedText = text.replace(/\\([\\`*_~[\]()#>|-])/gu, (_, character) => { held.push(character); return `${HOLD}${held.length - 1}${HOLD}` })
  const out = []
  let last = 0
  for (const match of protectedText.matchAll(/`+([^`\n]+?)`+/gu)) {
    out.push(inlineWithoutCode(protectedText.slice(last, match.index)))
    out.push(`<code>${escapeHtml(match[1].trim())}</code>`)
    last = match.index + match[0].length
  }
  out.push(inlineWithoutCode(protectedText.slice(last)))
  return out.join('').replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'gu'), (_, index) => escapeHtml(held[Number(index)]))
}

function inlineWithoutCode(text) {
  const out = []
  let last = 0
  for (const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu)) {
    out.push(linkifyHtml(text.slice(last, match.index)))
    out.push(`<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`)
    last = match.index + match[0].length
  }
  out.push(linkifyHtml(text.slice(last)))
  return emphasis(out.join(''))
}

function emphasis(html) {
  return html
    .replace(/\*\*([^*\n]+?)\*\*/gu, '<strong>$1</strong>')
    .replace(/(?<![\w/])__([^_\n]+?)__(?![\w/])/gu, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/gu, '<em>$1</em>')
    .replace(/(?<![\w/])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w/])/gu, '<em>$1</em>')
    .replace(/~~([^~\n]+?)~~/gu, '<del>$1</del>')
}
