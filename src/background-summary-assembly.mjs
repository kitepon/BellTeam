import { TeamBackgroundSummary } from './team-background-summary.mjs'
import { createBackgroundSummaryRunner } from './background-summary-runner.mjs'

// The parent retains authority and actual read completion; only the seven input fields cross IPC.
export function createTeamBackgroundSummary({ project, settings, models, conversation, notify, enabled,
  run = (...args) => createBackgroundSummaryRunner({ project, models })(...args) }) {
  return new TeamBackgroundSummary({
    configuration: () => settings.backgroundAgentConfiguration(),
    readInput: async (input, authority) => {
      if (authority.assertCurrent(input) === false) return null
      const assembly = conversation()
      const pending = assembly.run(authority.context.actor,
        () => assembly.facade.store.workInput(input), authority.context)
      let value
      try { value = await pending; await pending?.completion }
      catch (error) { await Promise.allSettled([pending?.completion]); throw error }
      return authority.assertCurrent(input) === false ? null : value
    },
    run, notify, enabled,
  })
}
