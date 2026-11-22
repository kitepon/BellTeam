export class Transport {
    #call(value) { return this.submit(value) }
    constructor() { this.jobs = new Map([['old-job', {}]]); this.callbacks = new Map() }
    submit(value) { return { version: 'old', value } }
    notify(value) { return this.#call(value) }
  }
