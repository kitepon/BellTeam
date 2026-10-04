export async function waitForShutdown(signalSource = process) {
  const keepalive = setInterval(() => {}, 3_600_000)
  try {
    await new Promise(resolve => {
      signalSource.once('SIGINT', resolve)
      signalSource.once('SIGTERM', resolve)
    })
  } finally {
    clearInterval(keepalive)
  }
}
