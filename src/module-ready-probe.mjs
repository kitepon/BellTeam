const failure = code => Object.assign(new Error(code), { code, status: 503, outcome: 'not_accepted' })

// One ordinary read on the actual candidate; READY alone cannot complete an activation.
export async function probeModuleReady(request) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(request), new Promise((_, reject) => {
      timer = setTimeout(() => reject(failure('READY_TIMEOUT')), 30_000)
    })])
  } catch (error) {
    if (error?.code === 'READY_TIMEOUT') throw error
    throw failure('READY_PROBE_FAILED')
  } finally { clearTimeout(timer) }
}
