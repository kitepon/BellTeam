export class Element {
  value = ''; files = []; children = []; handlers = {}; style = {}; disabled = false; open = false
  classList = { toggle() {}, add() {} }
  addEventListener(name, fn) { this.handlers[name] = fn }
  setAttribute() {}
  replaceChildren(...children) { this.children = children }
  append(...children) { this.children.push(...children) }
  reset() {}
  showModal() { this.open = true }
  close() { this.open = false; this.handlers.close?.() }
  querySelector(selector) { this.nodes ??= new Map(); if (!this.nodes.has(selector)) this.nodes.set(selector, new Element()); return this.nodes.get(selector) }
  querySelectorAll() { return [] }
  getContext() { return { clearRect() {}, drawImage() {} } }
  toDataURL() { return 'data:image/jpeg;base64,bmV3' }
  focus() {}
  remove() {}
}
export function editorDOM(t) {
  const previous = globalThis.document
  globalThis.document = { createElement: () => new Element(), addEventListener() {} }
  t.after(() => { globalThis.document = previous })
  const dialog = new Element()
  const get = id => dialog.querySelector('#' + id)
  get('bot-avatar-crop').width = 100; get('bot-avatar-crop').height = 100
  return { dialog, get, submit: form => get(form).handlers.submit({ preventDefault() {} }) }
}
export const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b }); return {promise,resolve,reject} }
export const bot = id => ({ id, name:id, displayName:id, harness:'codex', color:'violet', model:'model-a', reasoningEffort:'high', avatar:'/api/bots/'+id+'/avatar?v=123' })
export const models = { codex:{ efforts:['high'], models:[{id:'model-a',efforts:['high']}] } }
