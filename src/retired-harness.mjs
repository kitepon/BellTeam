// a365: a harness BellTeam no longer offers (Antigravity, a353). Data that already names it stays readable and visible;
// nothing new may choose it, and the user is told to pick another AI. Nothing here deletes or rewrites stored data.
export const RETIRED_HARNESSES = Object.freeze({ antigravity: 'antigravity-cli' })
export const retiredHarness = value => Object.hasOwn(RETIRED_HARNESSES, value)
export const retiredHarnessKind = value => Object.values(RETIRED_HARNESSES).includes(value)
export const RETIRED_HARNESS_NOTICE = 'このAI（Antigravity）は使えなくなりました。Claude・Codex・Grok・Cursorのどれかへ変更してください。'
