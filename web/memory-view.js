// Memory kinds the server accepts (src/memory-service.mjs MEMORY_KINDS) in the words the Owner reads; anything else is 「その他」.
export const memoryKindLabels = { fact: '事実', preference: '好み', policy: '方針', task: '継続中の仕事', config: '設定', incident: '出来事', relationship: '関係', episode: '思い出', growth: '成長' }
export const memoryKindLabel = kind => Object.hasOwn(memoryKindLabels, kind) ? memoryKindLabels[kind] : 'その他'

export function createMemoryView(dialog, { api }) {
  const find = id => dialog.querySelector(`#${id}`)
  const rememberForm = find('remember-form'), recallForm = find('recall-form'), knowledgeForm = find('knowledge-form'), searchForm = find('knowledge-search-form')
  const memoryResults = find('memory-results'), knowledgeResults = find('knowledge-results')
  const pending = new Map(), reads = new Map()
  let owner = null
  const value = id => find(id).value
  const memoryBody = () => ({ kind: value('remember-kind'), scope: value('remember-scope'), content: value('remember-content') })
  const knowledgeBody = () => ({ scope: value('knowledge-scope'), title: value('knowledge-title'), content: value('knowledge-content') })
  // Every action's sentence sits next to its own button: remember-result / knowledge-result beside 追加, the *-error lines inside the form, the search lines beside 検索.
  const say = (id, text = '', title = '') => { const node = find(id); node.textContent = text; node.title = title }
  const resultIds = ['remember-result', 'remember-error', 'recall-result', 'knowledge-result', 'knowledge-error', 'knowledge-search-result']
  const tabs = ['memory', 'knowledge']
  function show(tab) {
    for (const name of tabs) {
      const selected = name === tab
      find(`memory-tab-${name}`).setAttribute('aria-selected', String(selected))
      find(`memory-panel-${name}`).hidden = !selected
    }
  }
  for (const name of tabs) find(`memory-tab-${name}`).addEventListener('click', () => show(name))
  // 追加 opens a small form in front of the list; やめる / a saved entry closes it.
  const adders = [['remember', 'remember-content'], ['knowledge', 'knowledge-title']].map(([name, first]) => {
    const sheet = find(`${name}-sheet`)
    find(`${name}-open`).addEventListener('click', () => { sheet.hidden = false; find(first).focus?.() })
    find(`${name}-cancel`).addEventListener('click', () => { sheet.hidden = true })
    return { sheet }
  })
  function open(bot) {
    owner = { ...bot }
    for (const form of [rememberForm, recallForm, knowledgeForm, searchForm]) {
      form.reset()
      for (const button of form.querySelectorAll('button')) button.disabled = false
    }
    for (const { sheet } of adders) sheet.hidden = true
    for (const [id, label] of [['remember-submit', '記憶する'], ['knowledge-submit', '知識を保存'], ['recall-submit', '検索'], ['knowledge-search-submit', '検索']]) find(id).textContent = label
    note(memoryResults, '検索すると、ここに記憶が出ます。')
    note(knowledgeResults, '検索すると、ここに知識が出ます。')
    for (const id of resultIds) say(id)
    show('memory')
    find('memory-dialog-title').textContent = `${bot.name ?? bot.displayName}の記憶と知識`
    if (!dialog.open) dialog.showModal()
  }
  dialog.addEventListener('close', () => { if (!dialog.open) owner = null })
  async function write(form, submitId, label, resource, body, done, fail, errorId) {
    if (!owner || pending.get(form) === owner) return
    const target = owner, submit = find(submitId), idle = submit.textContent
    pending.set(form, target)
    for (const button of form.querySelectorAll('button')) button.disabled = true
    submit.textContent = `${label}しています…`
    say(errorId)
    try {
      await api(`/api/bots/${target.id}/${resource}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (owner === target) done()
    } catch (failure) { if (owner === target) say(errorId, fail, failure.message) }
    finally {
      if (pending.get(form) === target) pending.delete(form)
      if (owner === target) { submit.textContent = idle; for (const button of form.querySelectorAll('button')) button.disabled = false }
    }
  }
  async function search(resource, query, scope, container, format, submitId, resultId) {
    if (!owner) return
    const target = owner, reading = {}, submit = find(submitId)
    reads.set(resource, reading)
    say(resultId)
    submit.textContent = '検索しています…'
    try {
      const result = await api(`/api/bots/${target.id}/${resource}?query=${encodeURIComponent(query)}&scope=${scope}`)
      if (owner !== target || reads.get(resource) !== reading) return
      renderResults(container, result.items, format)
    } catch (failure) { if (owner === target && reads.get(resource) === reading) say(resultId, '検索できませんでした。もう一度「検索」を押してください。', failure.message) }
    finally { if (owner === target && reads.get(resource) === reading) submit.textContent = '検索' }
  }
  const finished = (sheet, text, resultId) => { sheet.hidden = true; say(resultId, text) }
  rememberForm.addEventListener('submit', event => {
    event.preventDefault()
    const body = memoryBody()
    void write(rememberForm, 'remember-submit', '記憶', 'memory', body, () => {
      // New text typed while the request ran stays in the form, which then stays open.
      if (JSON.stringify(memoryBody()) === JSON.stringify(body)) { find('remember-content').value = ''; finished(adders[0].sheet, '記憶しました。', 'remember-result') }
      else say('remember-result', '記憶しました。')
    }, '記憶できませんでした。もう一度「記憶する」を押してください。', 'remember-error')
  })
  knowledgeForm.addEventListener('submit', event => {
    event.preventDefault()
    const body = knowledgeBody()
    void write(knowledgeForm, 'knowledge-submit', '保存', 'knowledge', body, () => {
      if (JSON.stringify(knowledgeBody()) === JSON.stringify(body)) { knowledgeForm.reset(); finished(adders[1].sheet, '知識を保存しました。', 'knowledge-result') }
      else say('knowledge-result', '知識を保存しました。')
    }, '保存できませんでした。もう一度「知識を保存」を押してください。', 'knowledge-error')
  })
  recallForm.addEventListener('submit', event => {
    event.preventDefault()
    void search('memory', value('recall-query'), value('recall-scope'), memoryResults, item => [['span', 'memory-kind', memoryKindLabel(item.kind)], ['p', '', item.content]], 'recall-submit', 'recall-result')
  })
  searchForm.addEventListener('submit', event => {
    event.preventDefault()
    void search('knowledge', value('knowledge-query'), value('knowledge-search-scope'), knowledgeResults, item => [['strong', '', item.title], ['p', '', item.excerpt]], 'knowledge-search-submit', 'knowledge-search-result')
  })
  return { open }
}
function note(container, text) {
  const node = document.createElement('p')
  node.className = 'memory-empty'
  node.textContent = text
  container.replaceChildren(node)
}
function renderResults(container, items, format) {
  if (!items.length) { note(container, '見つかりませんでした。'); return }
  container.replaceChildren(...items.map(item => {
    const row = document.createElement('article')
    row.replaceChildren(...format(item).map(([tag, className, text]) => {
      const node = document.createElement(tag)
      if (className) node.className = className
      node.textContent = text
      return node
    }))
    return row
  }))
}
