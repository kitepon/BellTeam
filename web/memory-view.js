export function createMemoryView(dialog, { api }) {
  const find = id => dialog.querySelector(`#${id}`)
  const rememberForm = find('remember-form'), recallForm = find('recall-form'), knowledgeForm = find('knowledge-form'), searchForm = find('knowledge-search-form')
  const memoryResults = find('memory-results'), knowledgeResults = find('knowledge-results'), error = find('memory-form-error')
  const pending = new Map(), reads = new Map()
  let owner = null
  const value = id => find(id).value
  const memoryBody = () => ({ kind: value('remember-kind'), scope: value('remember-scope'), content: value('remember-content') })
  const knowledgeBody = () => ({ scope: value('knowledge-scope'), title: value('knowledge-title'), content: value('knowledge-content') })
  function open(bot) {
    owner = { ...bot }
    for (const form of [rememberForm, recallForm, knowledgeForm, searchForm]) {
      form.reset()
      for (const button of form.querySelectorAll('button')) button.disabled = false
    }
    memoryResults.replaceChildren()
    knowledgeResults.replaceChildren()
    error.textContent = ''
    find('memory-dialog-title').textContent = `${bot.displayName}の記憶と知識`
    if (!dialog.open) dialog.showModal()
  }
  dialog.addEventListener('close', () => { if (!dialog.open) owner = null })
  async function write(form, resource, body, done, label) {
    if (!owner || pending.get(form) === owner) return
    const target = owner
    pending.set(form, target)
    for (const button of form.querySelectorAll('button')) button.disabled = true
    error.textContent = ''
    try {
      await api(`/api/bots/${target.id}/${resource}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (owner === target) done()
    } catch (failure) { if (owner === target) error.textContent = `${label}（${failure.message}）` }
    finally {
      if (pending.get(form) === target) pending.delete(form)
      if (owner === target) for (const button of form.querySelectorAll('button')) button.disabled = false
    }
  }
  async function search(resource, query, scope, container, format) {
    if (!owner) return
    const target = owner, reading = {}
    reads.set(resource, reading)
    error.textContent = ''
    try {
      const result = await api(`/api/bots/${target.id}/${resource}?query=${encodeURIComponent(query)}&scope=${scope}`)
      if (owner !== target || reads.get(resource) !== reading) return
      renderResults(container, result.items, format)
    } catch (failure) { if (owner === target && reads.get(resource) === reading) error.textContent = `検索できませんでした（${failure.message}）` }
  }
  rememberForm.addEventListener('submit', event => {
    event.preventDefault()
    const body = memoryBody()
    void write(rememberForm, 'memory', body, () => {
      if (JSON.stringify(memoryBody()) === JSON.stringify(body)) find('remember-content').value = ''
      memoryResults.textContent = '記憶しました。'
    }, '記憶できませんでした')
  })
  knowledgeForm.addEventListener('submit', event => {
    event.preventDefault()
    const body = knowledgeBody()
    void write(knowledgeForm, 'knowledge', body, () => {
      if (JSON.stringify(knowledgeBody()) === JSON.stringify(body)) knowledgeForm.reset()
      knowledgeResults.textContent = '知識を保存しました。'
    }, '保存できませんでした')
  })
  recallForm.addEventListener('submit', event => {
    event.preventDefault()
    void search('memory', value('recall-query'), value('recall-scope'), memoryResults, item => `[${item.kind}] ${item.content}`)
  })
  searchForm.addEventListener('submit', event => {
    event.preventDefault()
    void search('knowledge', value('knowledge-query'), value('knowledge-search-scope'), knowledgeResults, item => `${item.title}\n${item.excerpt}`)
  })
  return { open }
}
function renderResults(container, items, format) {
  if (!items.length) { container.textContent = '見つかりませんでした。'; return }
  container.replaceChildren(...items.map(item => {
    const row = document.createElement('article')
    row.textContent = format(item)
    return row
  }))
}
