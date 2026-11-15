// Owner-task port (README L20; Approval Box extension, R3, Owner 2026-11-15): the Owner actor may write only decision tasks.
// Named protection (README L17: privilege escalation, an Owner-named write): a refused call runs nothing; the caller fixes its args and calls again.
import { latticeError } from '../lattice-protocol.mjs'

export const DECISION_PLAN = 'approval-box'
// The Owner-wait lane (a189). shortcut: `owner` stays accepted until Delta's a188 switch is live; then drop it.
const OWNER_LANES = ['approval-box', 'owner']
export const decisionTask = (plan, task) => plan === DECISION_PLAN && typeof task === 'string' && /^dec-[a-z0-9-]{1,100}$/u.test(task)
const refuse = reason => Object.assign(latticeError('LATTICE_OWNER_TASK_REFUSED', 403), { detail: reason })
// The flags each command may carry (value = takes one value, bool = none), read from the bundled Lattice's `todo --help`. Anything else is refused,
// so a file flag (`--evidence`, `--input`, `--test-result`, ...) now or in a later Lattice never reaches the CLI as the server uid (Epinel gate, #1573).
const PLAN_REF = ['--plan', '--task']
const FLAGS = {
  'plan create': { '--json': 'bool', '--serialization-reviewed': 'bool' },
  add: Object.fromEntries([...PLAN_REF, '--title', '--phase', '--lane', '--done-condition', '--design-memo', '--after', '--before', '--reason'].map(name => [name, 'value'])),
  start: { '--plan': 'value', '--task': 'value', '--override-reason': 'value', '--parallel-frontier': 'bool' },
  done: { '--plan': 'value', '--task': 'value', '--message': 'value' },
  note: { '--plan': 'value', '--task': 'value', '--message': 'value' },
  retire: { '--plan': 'value', '--task': 'value', '--reason': 'value' },
  retract: { '--plan': 'value', '--task': 'value', '--reason': 'value' },
  predecessor: Object.fromEntries([...PLAN_REF, '--after', '--reason'].map(name => [name, 'value'])),
}

// Reads args[from..] against the allowed flags -> Map name -> value (true for a bool flag). An unknown flag, `--flag=value`, a repeated flag,
// a missing value or a stray word is refused.
// shortcut: a value that itself starts with `--` is read as a missing value; upgrade if a caller needs one.
function readFlags(args, from, allowed) {
  const found = new Map()
  for (let i = from; i < args.length; i++) {
    const name = args[i], kind = Object.hasOwn(allowed, name) ? allowed[name] : null
    if (!kind || found.has(name)) throw refuse(name.slice(0, 40))
    if (kind === 'bool') { found.set(name, true); continue }
    if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw refuse(name)
    found.set(name, args[++i])
  }
  return found
}

// linked(plan, task) -> the card was registered with `link` (decision-driven, lane owner). Throws LATTICE_OWNER_TASK_REFUSED.
export function ownerTaskCheck(args, input, linked) {
  const own = (plan, task) => decisionTask(plan, task) || (typeof plan === 'string' && typeof task === 'string' && linked(plan, task))
  if (args[0] === 'plan' && args[1] === 'create') {
    readFlags(args, 2, FLAGS['plan create'])
    const tasks = input?.tasks
    if (input?.plan_key !== DECISION_PLAN || !Array.isArray(tasks) || !tasks.every(task => OWNER_LANES.includes(task?.lane) && decisionTask(DECISION_PLAN, task.task_id))) throw refuse('plan create input')
    return
  }
  if (args[0] !== 'todo' || input !== null) throw refuse('command')
  // Lattice 0.104.0 (a161): `predecessor add|remove` replaced `dependency connect|disconnect` (same chart only); Delta switched (#1627), the old verbs are refused.
  if (args[1] === 'predecessor' && (args[2] === 'add' || args[2] === 'remove')) {
    const flags = readFlags(args, 3, FLAGS.predecessor), after = String(flags.get('--after') ?? '').split('/')
    if (after.length !== 2 || !own(flags.get('--plan'), flags.get('--task')) && !own(after[0], after[1])) throw refuse('predecessor ends')
    return
  }
  if (!Object.hasOwn(FLAGS, args[1]) || args[1] === 'predecessor' || args[1] === 'plan create') throw refuse('verb')
  const flags = readFlags(args, 2, FLAGS[args[1]]), plan = flags.get('--plan'), task = flags.get('--task')
  // A task is made only as a decision task of the Owner-wait lane; the others are driven only if they are decision tasks or were linked.
  if (args[1] === 'add' ? !decisionTask(plan, task) || !OWNER_LANES.includes(flags.get('--lane')) : !own(plan, task)) throw refuse('task')
}
