export const RESUME_STATE_BASE = '/srv/bellteam-aiterm'

export function fixedResumeBase(environment = process.env) {
  return environment.AITERM_STATE_BASE === RESUME_STATE_BASE ? RESUME_STATE_BASE : null
}

export function checkResumeEnvironment(environment, inherited) {
  const base = fixedResumeBase(inherited)
  if (base && environment.AITERM_STATE_BASE !== base)
    throw Object.assign(new Error('RESUME_STATE_BASE_CONFLICT'), { code: 'RESUME_STATE_BASE_CONFLICT' })
  return environment
}
