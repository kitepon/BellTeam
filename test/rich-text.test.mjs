import assert from 'node:assert/strict'
import test from 'node:test'
import { richTextHtml } from '../web/rich-text.js'

test('段落と改行: 空行で段落を分け、単独の改行は行送りにする', () => {
  assert.equal(richTextHtml('一行目\n二行目\n\n次の段落'), '<p>一行目<br>二行目</p><p>次の段落</p>')
  assert.equal(richTextHtml('<b>x</b> & y'), '<p>&lt;b&gt;x&lt;/b&gt; &amp; y</p>')
})

test('行内: コード片・強調・打消し・リンク・裸のURL・バックスラッシュ退避', () => {
  assert.equal(richTextHtml('`a<b` と **太** と *斜* と ~~消~~'), '<p><code>a&lt;b</code> と <strong>太</strong> と <em>斜</em> と <del>消</del></p>')
  assert.equal(richTextHtml('[GitHub](https://github.com/x) と https://x.com/a 。'), '<p><a href="https://github.com/x" target="_blank" rel="noopener noreferrer">GitHub</a> と <a href="https://x.com/a" target="_blank" rel="noopener noreferrer">https://x.com/a</a> 。</p>')
  assert.equal(richTextHtml('snake_case_name と \\*そのまま\\*'), '<p>snake_case_name と *そのまま*</p>')
  assert.equal(richTextHtml('[怪しい](javascript:alert(1))'), '<p>[怪しい](javascript:alert(1))</p>')
})

test('ブロック: 見出し・引用・区切り線・囲みコード', () => {
  assert.equal(richTextHtml('# 見出し\n---\n> 引用の\n> **続き**'), '<h1>見出し</h1><hr><blockquote><p>引用の<br><strong>続き</strong></p></blockquote>')
  assert.equal(richTextHtml('```js\nconst x = 1 < 2\n**そのまま**\n```'), '<pre><code class="language-js">const x = 1 &lt; 2\n**そのまま**</code></pre>')
})

test('箇条書き: 入れ子・番号・チェック', () => {
  assert.equal(richTextHtml('- 一つ\n- 二つ\n  - 入れ子\n1. 番号\n2. 番号2\n- [x] 済み\n- [ ] 未'),
    '<ul><li>一つ</li><li>二つ<ul><li>入れ子</li></ul></li></ul><ol><li>番号</li><li>番号2</li></ol><ul><li class="task"><input type="checkbox" disabled checked> 済み</li><li class="task"><input type="checkbox" disabled> 未</li></ul>')
  assert.equal(richTextHtml('3. 三から\n4. 四'), '<ol start="3"><li>三から</li><li>四</li></ol>')
})

test('表: 見出し行・寄せ・セル内のエスケープ', () => {
  assert.equal(richTextHtml('| 名 | 値 |\n|:--|--:|\n| a | 1 |\n| b \\| c | `2` |'),
    '<div class="table-scroll"><table><thead><tr><th style="text-align:left">名</th><th style="text-align:right">値</th></tr></thead><tbody><tr><td style="text-align:left">a</td><td style="text-align:right">1</td></tr><tr><td style="text-align:left">b | c</td><td style="text-align:right"><code>2</code></td></tr></tbody></table></div>')
  assert.equal(richTextHtml('a | b だけ'), '<p>a | b だけ</p>')
})
