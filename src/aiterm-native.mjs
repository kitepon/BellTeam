import { basename } from 'node:path'

// a532b2 stage 5 (docs/architecture/modules/runtime/cli-registration.md, "Generic Aiterm entry"): the parent's own Aiterm registration is the generic
// `native-entry.js` (aiterm-mcp >= 0.70.109) or the old `execution-native-server.js`, which marks itself with `--execution-interrupt`.
// The new entry accepts and ignores that flag, so one command line starts either entry; the flag stays a marker until Aiterm drops the old entry.
export const isGenericEntry = file => /^native-entry\./u.test(basename(String(file ?? '')))
export const isNativeRegistration = args => Array.isArray(args) && (args.includes('--execution-interrupt') || isGenericEntry(args[0]))
