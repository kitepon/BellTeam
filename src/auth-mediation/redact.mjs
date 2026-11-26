// Replaces exact secret values in text returned to an AI. shortcut: encoded or split values are not caught, upgrade only if such a leak is seen.
export function redact(text, env) {
  let out = text
  for (const [name, value] of Object.entries(env).sort((a, b) => b[1].length - a[1].length))
    if (value.length >= 6) out = out.split(value).join(`[redacted:${name}]`)
  return out
}
