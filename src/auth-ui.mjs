import { isDeepStrictEqual } from 'node:util'
const stages = ['open_url', 'device_code', 'paste_code', 'select', 'waiting', 'complete', 'failed', 'unavailable']
const actionable = ['open_url', 'device_code', 'paste_code', 'select']
const text = value => typeof value === 'string' && value.length > 0
const bindingKeys = ['session_id', 'launch_id', 'metadata_identity', 'native_id', 'pane_id', 'server_pid', 'server_started', 'pane_pid', 'pane_started']
const bindingValid = binding => binding && typeof binding === 'object' && !Array.isArray(binding)
  && Object.keys(binding).length === bindingKeys.length && bindingKeys.every(key => Object.hasOwn(binding, key))
  && ['session_id', 'metadata_identity', 'native_id', 'pane_id', 'server_started', 'pane_started'].every(key => text(binding[key]))
  && (binding.launch_id === null || text(binding.launch_id))
  && ['server_pid', 'pane_pid'].every(key => Number.isSafeInteger(binding[key]) && binding[key] > 0)
const urlValid = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
}
const empty = { binding: null, url: null, user_code: null, input: null, prompt_digest: null, choices: [] }
const unavailable = () => ({ schema: 'aiterm.auth-ui.v1', ...empty, stage: 'unavailable', title: 'ログインの案内を取得できません',
  message: '認証の手順を確認できませんでした。処理を保持しています。状態を更新して確認してください。' })

// The adapter owns official prompts and existing native identities. Missing legacy
// launch_id stays null; an input_required flag does not identify a code prompt.
export function authUi(receipt, session) {
  const ui = receipt.auth_ui
  if (ui === undefined) {
    if (receipt.status === 'authenticated') return { schema: 'aiterm.auth-ui.v1', ...empty, stage: 'complete', title: 'ログイン状態を確認しました', message: receipt.message ?? '' }
    return unavailable()
  }
  if (!ui || ui.schema !== 'aiterm.auth-ui.v1' || !stages.includes(ui.stage)
    || !text(ui.title) || typeof ui.message !== 'string'
    || ui.binding !== null && !bindingValid(ui.binding)
    || ui.binding && (!session || ui.binding.session_id !== session)
    || actionable.includes(ui.stage) && (!bindingValid(ui.binding) || !session)
    || ![null, 'authorization_code', 'choice'].includes(ui.input)
    || ui.prompt_digest !== null && !/^[a-f0-9]{64}$/u.test(ui.prompt_digest)
    || ui.url !== null && !urlValid(ui.url)
    || ui.user_code !== null && !text(ui.user_code)
    || ['open_url', 'device_code'].includes(ui.stage) && !urlValid(ui.url)
    || ui.stage === 'device_code' && !text(ui.user_code)
    || ui.stage === 'paste_code' && (!urlValid(ui.url) || ui.input !== 'authorization_code' || !text(ui.prompt_digest))
    || ui.stage === 'select' && (ui.input !== 'choice' || !text(ui.prompt_digest))
    || !Array.isArray(ui.choices) || ui.choices.some(choice => !choice || !/^option-[1-9]$/u.test(choice.id) || !text(choice.label))
    || new Set(ui.choices.map(choice => choice.id)).size !== ui.choices.length
    || ui.stage === 'select' && !ui.choices.length) return unavailable()
  return { schema: ui.schema, binding: ui.binding ? Object.fromEntries(bindingKeys.map(key => [key, ui.binding[key]])) : null,
    stage: ui.stage, title: ui.title, message: ui.message,
    url: ['open_url', 'device_code', 'paste_code', 'waiting'].includes(ui.stage) ? ui.url : null,
    user_code: ui.stage === 'device_code' ? ui.user_code : null,
    input: ['paste_code', 'select'].includes(ui.stage) ? ui.input : null, prompt_digest: ui.prompt_digest,
    choices: ui.stage === 'select' ? ui.choices.map(({ id, label }) => ({ id, label })) : [] }
}

export function authResponse(input, session, ui) {
  const fail = () => { throw Object.assign(new Error('AUTH_RESPONSE_INVALID'), { code: 'AUTH_RESPONSE_INVALID', status: 409,
    publicMessage: '認証の状態を更新してから、表示された手順で操作してください。' }) }
  if (!input || Object.keys(input).some(key => !['binding', 'prompt_digest', 'response'].includes(key))
    || !bindingValid(input.binding) || input.binding.session_id !== session || !isDeepStrictEqual(input.binding, ui?.binding)
    || !text(input.prompt_digest) || input.prompt_digest !== ui.prompt_digest) fail()
  const response = input.response
  if (!response || typeof response !== 'object' || Array.isArray(response)) fail()
  if (response.kind === 'authorization_code') {
    if (ui.stage !== 'paste_code' || Object.keys(response).some(key => !['kind', 'value'].includes(key))
      || typeof response.value !== 'string' || response.value.length > 8192 || !/^[!-~]+$/u.test(response.value)) fail()
  } else if (response.kind === 'choice') {
    if (ui.stage !== 'select' || !ui.choices.some(choice => choice.id === response.id)
      || Object.keys(response).some(key => !['kind', 'id'].includes(key)) || !text(response.id)) fail()
  } else fail()
  return { expected_binding: input.binding, expected_prompt_digest: input.prompt_digest, response }
}

export function authResponseFailure(result, session) {
  const value = result?.structuredContent
  if (!result?.isError || value?.schema !== 'aiterm.auth-response-error.v1') return
  const valid = value.session_id === session && ['not_issued', 'unknown'].includes(value.effect) && text(value.code)
  return Object.assign(new Error(valid && value.effect === 'not_issued' ? '認証の入力は送信されませんでした。状態を更新してください。' : '認証結果を確認できませんでした。状態を更新してください。'), {
    code: valid && value.effect === 'not_issued' ? 'AUTH_RESPONSE_NOT_ISSUED' : 'AUTH_RESPONSE_UNCONFIRMED',
    status: valid && value.effect === 'not_issued' ? 409 : 502, effect: valid ? value.effect : 'unknown',
  })
}

export function authReceipt(result, session, invalid) {
  const failure = authResponseFailure(result, session)
  if (failure) throw failure
  const receipt = result.structuredContent
  if (receipt?.schema !== 'aiterm.agent-auth-result.v1' || !['waiting', 'authenticated', 'blocked', 'failed'].includes(receipt.status))
    throw invalid()
  return receipt
}
