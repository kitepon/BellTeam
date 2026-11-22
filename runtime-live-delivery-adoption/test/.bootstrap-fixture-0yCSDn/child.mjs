import { Transport } from './old.mjs'
    const transport = new Transport(), jobs = transport.jobs, callbacks = transport.callbacks;
    let resolveOld, oldDone = false, callbackCount = 0;
    const oldPromise = new Promise(resolve => { resolveOld = resolve });
    const oldCallback = () => { callbackCount++; oldDone = true; return 'old-completed' };
    callbacks.set('old-job', oldCallback);
    const completion = oldPromise.then(oldCallback);
    globalThis.probe = { transport, jobs, callbacks, oldPromise, oldCallback, completion, ticks: 0,
      inspect() { return { sameJobs: transport.jobs === jobs, sameCallbacks: transport.callbacks === callbacks,
        sameOldCallback: callbacks.get('old-job') === oldCallback, oldDone, callbackCount, ticks: this.ticks,
        result: transport.notify('new-message') } } };
    const heartbeat = setInterval(() => probe.ticks++, 5);
    process.on('message', async message => {
      if (message === 'finish') { resolveOld(); await completion; process.send(probe.inspect()); clearInterval(heartbeat); process.disconnect() }
    });
    process.send({ ready: true, pid: process.pid });
  