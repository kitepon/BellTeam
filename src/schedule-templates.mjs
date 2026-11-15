// A template expands ONCE at save into the stored command (exit 0 done, 75 not yet, other = failed); `until` is a hard deadline.
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/u
const NUMBER = /^[1-9]\d{0,17}$/u
const PACKAGE = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/u
const VERSION = /^[\w.+-]{1,100}$/u
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
const url = value => {
  if (typeof value !== 'string' || value.length > 2000 || /\s/u.test(value)) return false
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}

// shortcut: no jq filter for `url`, 2xx = done and 404 = not yet; add one when a caller needs a body check.
const kinds = {
  ci: {
    fields: { repo: value => REPO.test(value), run: value => NUMBER.test(value) },
    check: ({ repo, run }) => `out=$(gh run view ${run} -R ${quote(repo)} --json status,conclusion --jq '.status + " " + (.conclusion // "")') || exit 1
case "$out" in "completed success") echo "CI run ${run}: success"; exit 0;; completed*) echo "CI run ${run}: $out" >&2; exit 1;; esac
exit 75`,
  },
  'pr-merged': {
    fields: { repo: value => REPO.test(value), number: value => NUMBER.test(value) },
    check: ({ repo, number }) => `state=$(gh pr view ${number} -R ${quote(repo)} --json state --jq .state) || exit 1
case "$state" in MERGED) echo "PR ${number}: merged"; exit 0;; OPEN) exit 75;; esac
echo "PR ${number}: $state" >&2; exit 1`,
  },
  npm: {
    fields: { package: value => PACKAGE.test(value), version: value => VERSION.test(value) },
    check: ({ package: name, version }) => `out=$(npm view ${quote(`${name}@${version}`)} version 2>&1) && { echo "$out"; exit 0; }
case "$out" in *E404*) exit 75;; esac
echo "$out" >&2; exit 1`,
  },
  url: {
    fields: { url },
    check: ({ url: target }) => `code=$(curl -s -o /dev/null -w '%{http_code}' ${quote(target)}) || exit 1
case "$code" in 2??) echo "HTTP $code"; exit 0;; 404) exit 75;; esac
echo "HTTP $code" >&2; exit 1`,
  },
}

export const TEMPLATE_KINDS = Object.freeze(Object.keys(kinds))
const invalid = () => { throw new Error('SCHEDULE_TEMPLATE_INVALID') }

export function validateTemplate(template) {
  const kind = kinds[template?.kind]
  if (!kind || !Object.hasOwn(kinds, template.kind) || Object.keys(template).some(key => !['kind', 'params', 'until'].includes(key))) invalid()
  const { params, until } = template
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).sort().join() !== Object.keys(kind.fields).sort().join()
    || Object.entries(kind.fields).some(([key, check]) => typeof params[key] !== 'string' || !check(params[key]))) invalid()
  if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) invalid()
  return kind
}

export function expandTemplate(template) {
  const kind = validateTemplate(template)
  const deadline = Math.floor(Date.parse(template.until) / 1000)
  const command = `[ "$(date +%s)" -ge ${deadline} ] && { echo "deadline passed: ${new Date(deadline * 1000).toISOString()}" >&2; exit 1; }\n${kind.check(template.params)}`
  if (command.length > 8000) throw new Error('SCHEDULE_COMMAND_INVALID')
  return command
}
