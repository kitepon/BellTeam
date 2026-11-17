// a365: a harness BellTeam no longer offers (Antigravity, a353). Data that already names it stays readable and visible;
// nothing new may choose it, and the user is told to pick another AI. Nothing here deletes or rewrites stored data.
export const RETIRED_HARNESSES = Object.freeze({ antigravity: 'antigravity-cli' })
export const retiredHarness = value => Object.hasOwn(RETIRED_HARNESSES, value)
export const retiredHarnessKind = value => Object.values(RETIRED_HARNESSES).includes(value)
// a368: the notice is added where the body presents a member (HTTP), never carried inside module IPC records, so an older body accepts a newer members module.
export const RETIRED_HARNESS_NOTICE = 'このAI（Antigravity）は使えなくなりました。Claude・Codex・Grok・Cursorのどれかへ変更してください。'
export const harnessNoticeFor = bot => retiredHarness(bot?.harness) ? { harnessNotice: RETIRED_HARNESS_NOTICE } : {}
