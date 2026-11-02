import { Element } from './editor-dom.mjs'

export function webDOM(t) {
  const nodes = new Map(), windowEvents = new Map(), reads = new Map()
  class WebElement extends Element {
    dataset = {}; hidden = true; clientWidth = 0; clientHeight = 100; scrollHeight = 100; scrollTop = 0
    classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name), contains: name => this.classes.has(name), toggle() {} }
    classes = new Set()
    querySelector(selector) {
      if (selector.startsWith('#')) return get(selector.slice(1))
      if (selector.startsWith('[data-id=')) return this.querySelectorAll(selector)[0] ?? null
      this.parts ??= new Map()
      if (!this.parts.has(selector)) this.parts.set(selector, new WebElement())
      return this.parts.get(selector)
    }
    querySelectorAll(selector) {
      return this.children.flatMap(child => {
        const match = selector.startsWith('[data-id=') ? child.dataset?.id === selector.slice(10, -2)
          : selector === '[data-stop-bot-id]' && child.dataset?.stopBotId
        return [...(match ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])]
      })
    }
    append(...children) { for (const child of children) { if (typeof child === 'object') child.parent = this; this.children.push(child) } }
    replaceChildren(...children) { this.children = []; this.append(...children) }
    replaceWith(node) { const index = this.parent.children.indexOf(this); this.parent.children.splice(index, 1, node); node.parent = this.parent }
    scrollTo({ top }) { this.scrollTop = top }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new WebElement()); return nodes.get(id) }
  const previous = Object.fromEntries(['document', 'window', 'localStorage', 'ResizeObserver', 'CSS'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    document: { querySelector: selector => get(selector.slice(1)), querySelectorAll: () => [], createElement: () => new WebElement(), addEventListener() {}, fonts: { ready: Promise.resolve() } },
    window: { addEventListener: (type, handler) => windowEvents.set(type, handler) },
    localStorage: { getItem: key => reads.get(key), setItem: (key, value) => reads.set(key, value), removeItem: key => reads.delete(key) },
    ResizeObserver: class { observe() {} }, CSS: { escape: value => value },
  })
  t.after(() => {
    windowEvents.get('pagehide')?.({ persisted: false })
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { get, windowEvents, reads, choose: id => get('bot-list').children.find(node => node.dataset.conversation === id).handlers.click(),
    submit: () => get('composer').handlers.submit({ preventDefault() {} }) }
}
