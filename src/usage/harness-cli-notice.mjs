// a451: the AI names and the one plain sentence a member shows. Kept apart so the parent assembly can import it without the rest.
export const CLI_IDS = Object.freeze(['claude', 'codex', 'grok', 'cursor'])
const NAMES = { claude: 'Claude', codex: 'Codex', grok: 'Grok', cursor: 'Cursor' }

// The one sentence a member (Bot DTO) shows; null while there is nothing to say.
export function cliNotice(id, state) {
  const name = NAMES[id]
  if (state === 'not_installed') return `${name}がまだ入っていません。AIの認証から入れてください`
  if (state === 'installing') return `${name}を入れています。終わるまでお待ちください`
  if (state === 'failed') return `${name}を入れられませんでした。AIの認証からもう一度入れてください`
  return null
}
