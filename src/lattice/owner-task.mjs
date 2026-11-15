// Owner-task port (README L20; Approval Box extension, R3, Owner 2026-11-15): the Owner actor may write only decision tasks.
// Named protection (README L17: privilege escalation, an Owner-named write): a refused call runs nothing; the caller fixes its args and calls again.
import { latticeError } from '../lattice-protocol.mjs'

export const DECISION_PLAN = 'approval-box'
export const decisionTask = (plan, task) => plan === DECISION_PLAN && typeof task === 'string' && /^dec-[a-z0-9-]{1,100}$/u.test(task)
const refuse = reason => Object.assign(latticeError('LATTICE_OWNER_TASK_REFUSED', 403), { detail: reason })
// Flags that make Lattice read a file as the server uid.
const FILE_FLAGS = new Set(['--evidence', '--input', '--file'])

// The one value of `--name <value>`; null when absent. Twice, `--name=value` or no value is refused.
// shortcut: a value that itself starts with `--` is read as a missing value; upgrade if a caller needs one.
function flag(args, name) {
  let value = null
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(`${name}=`)) throw refuse(`${name}=`)
    if (args[i] !== name) continue
    if (value !== null || i + 1 >= args.length || args[i + 1].startsWith('--')) throw refuse(name)
    value = args[++i]
  }
  return value
}

// linked(plan, task) -> the card was registered with `link` (decision-driven, lane owner). Throws LATTICE_OWNER_TASK_REFUSED.
export function ownerTaskCheck(args, input, linked) {
  const own = (plan, task) => decisionTask(plan, task) || (typeof plan === 'string' && typeof task === 'string' && linked(plan, task))
  if (args.some(arg => FILE_FLAGS.has(arg.split('=')[0]))) throw refuse('file flag')
  if (args[0] === 'plan' && args[1] === 'create') {
    if (!args.slice(2).every(arg => arg === '--json' || arg === '--serialization-reviewed')) throw refuse('plan create flags')
    const tasks = input?.tasks
    if (input?.plan_key !== DECISION_PLAN || !Array.isArray(tasks) || !tasks.every(task => task?.lane === 'owner' && decisionTask(DECISION_PLAN, task.task_id))) throw refuse('plan create input')
    return
  }
  if (args[0] !== 'todo' || input !== null) throw refuse('command')
  if (args[1] === 'dependency' && (args[2] === 'connect' || args[2] === 'disconnect')) {
    if (flag(args, '--from-project') !== null) throw refuse('--from-project')
    if (!own(flag(args, '--from-plan'), flag(args, '--from-task')) && !own(flag(args, '--to-plan'), flag(args, '--to-task'))) throw refuse('dependency ends')
    return
  }
  if (!['add', 'start', 'done', 'retire', 'note', 'retract'].includes(args[1])) throw refuse('verb')
  const plan = flag(args, '--plan'), task = flag(args, '--task')
  // A task is made only as a decision task of lane owner; the others are driven only if they are decision tasks or were linked.
  if (args[1] === 'add' ? !decisionTask(plan, task) || flag(args, '--lane') !== 'owner' : !own(plan, task)) throw refuse('task')
}
