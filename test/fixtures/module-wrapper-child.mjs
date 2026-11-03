const [component, root, version] = process.argv.slice(2)
const versionId = version === 'builtin' ? null : version
if (component === 'diagnostics') {
  const { createDiagnosticsDispatcher } = await import('../../src/diagnostics-dispatcher.mjs')
  const { createDiagnosticsChildChannel } = await import('../../src/diagnostics-ipc.mjs')
  createDiagnosticsChildChannel({ dispatcher: createDiagnosticsDispatcher({ root }), versionId })
} else if (component === 'usage') {
  const { createUsageChildChannel } = await import('../../src/usage/channel.mjs')
  const { createUsageChannelDispatcher } = await import('../../src/usage/channel-dispatcher.mjs')
  let channel
  const dispatcher = createUsageChannelDispatcher({ root,
    effect: (...args) => channel.effect(...args), projection: (...args) => channel.projection(...args) })
  channel = createUsageChildChannel({ ...dispatcher, versionId })
} else throw new Error('FIXTURE_COMPONENT_INVALID')
