import { createHash } from 'node:crypto'
import words from './working-words.json' with { type: 'json' }

// working-word.md: the one canonical list of Claude Code's spinner words; the apps keep no copy and draw the `workingWord` of a running queue row.
export const WORKING_WORDS = Object.freeze([...words])

// The same delivery always maps to the same word, so every app and device shows one word for the whole turn and a new turn picks another.
export const workingWord = key => WORKING_WORDS[createHash('sha256').update(String(key)).digest().readUInt32BE(0) % WORKING_WORDS.length]

export const withWorkingWord = items => items.map(item => item.status === 'running' ? { ...item, workingWord: workingWord(item.groupId ?? item.id) } : item)
