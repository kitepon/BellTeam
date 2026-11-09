// S5 folder check on save (modules/members/remote-seat.md "Folder check on save"): parent side, before the members child saves.
const refuse = (code, status, message) => Object.assign(new Error(message), { code, status, publicMessage: message, outcome: 'not_accepted' })

export function memberFolderSlug(name) {
  const slug = String(name ?? '').trim().replace(/[/:\0]/gu, '-')
  return slug && slug !== '.' && slug !== '..' ? slug : 'member'
}

// Wraps create/update/previewUpdate of the facade's bots in place; terminals() returns the core or null.
export function withMemberFolderCheck(bots, terminals) {
  const { create, update, previewUpdate } = bots
  const split = input => {
    if (!input || typeof input !== 'object' || !Object.hasOwn(input, 'createFolder')) return [input, false]
    const { createFolder, ...rest } = input
    if (typeof createFolder !== 'boolean') throw refuse('BOT_UPDATE_FIELD_INVALID', 400, 'createFolder must be true or false')
    return [rest, createFolder]
  }
  const touches = (input, createFolder) => createFolder || Boolean(input && typeof input === 'object'
    && (Object.hasOwn(input, 'terminalId') || Object.hasOwn(input, 'projectRoot')))
  // Returns the input with a default projectRoot and the binding to check, or null when no check applies.
  async function resolve(current, input, createFolder) {
    const core = terminals()
    if (typeof core?.folder !== 'function' || !touches(input, createFolder)) return { input, binding: null }
    const terminalId = input.terminalId ?? current?.terminalId ?? ''
    const projectRoot = input.projectRoot ?? current?.projectRoot ?? ''
    // Local member or a malformed value: the members registry validates and refuses.
    if (typeof terminalId !== 'string' || !terminalId || typeof projectRoot !== 'string') return { input, binding: null }
    if (projectRoot) return { input, binding: createFolder || terminalId !== current?.terminalId || projectRoot !== current?.projectRoot ? { terminalId, projectRoot } : null }
    const terminal = await core.registry.get(terminalId)
    if (!terminal) throw refuse('TERMINAL_NOT_FOUND', 404, `terminal ${terminalId} is not registered`)
    const root = `/Users/${terminal.user}/BellTeam/${memberFolderSlug(input.name ?? current?.name)}`
    return { input: { ...input, terminalId, projectRoot: root }, binding: { terminalId, projectRoot: root } }
  }
  async function check(binding, createFolder) {
    let result
    try { result = await terminals().folder({ terminalId: binding.terminalId, path: binding.projectRoot, create: createFolder }) }
    catch (error) {
      if (error?.code === 'INVALID_PATH') throw refuse('BOT_PROJECT_ROOT_INVALID', 400, error.message)
      throw error
    }
    const { reason, action, observedAt } = result
    if (reason === 'TERMINAL_NOT_FOUND' || reason?.startsWith('FOLDER_'))
      throw Object.assign(refuse(reason, reason === 'TERMINAL_NOT_FOUND' ? 404 : 409, `${action ?? reason} (${binding.projectRoot})`),
        { projectRoot: binding.projectRoot, ...(action ? { action } : {}) })
    return { checked: reason === null, reason, observedAt, ...(action ? { action } : {}) }
  }
  const save = async (current, raw, createFolder, run) => {
    const { input, binding } = await resolve(current, raw, createFolder)
    const folderCheck = binding ? await check(binding, createFolder) : null
    const bot = await run(input)
    return folderCheck ? { ...bot, folderCheck } : bot
  }
  const currentOf = (botId, input, createFolder, context) =>
    typeof terminals()?.folder === 'function' && touches(input, createFolder) ? bots.readMember(botId, context) : null
  bots.create = async (value, context) => {
    const [input, createFolder] = split(value)
    return save(null, input, createFolder, saved => create(saved, context))
  }
  bots.update = async (botId, changes, context) => {
    const [input, createFolder] = split(changes)
    return save(await currentOf(botId, input, createFolder, context), input, createFolder, saved => update(botId, saved, context))
  }
  bots.previewUpdate = async (botId, changes, context) => {
    const [input, createFolder] = split(changes)
    return previewUpdate(botId, (await resolve(await currentOf(botId, input, createFolder, context), input, createFolder)).input, context)
  }
  return bots
}
