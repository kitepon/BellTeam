// Sends 20 frames back to back; the first one is invalid for createModuleStreams.
for (let i = 0; i < 20; i++) process.send({ type: 'bogus', index: i })
setTimeout(() => process.exit(0), 100)
