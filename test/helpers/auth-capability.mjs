export function authTool() {
  const string = { type: 'string' }, nullable = { type: ['string', 'null'] }
  const closed = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
  const binding = closed({ session_id: string, launch_id: nullable, metadata_identity: string, native_id: string,
    pane_id: string, server_pid: { type: 'integer', exclusiveMinimum: 0 }, server_started: string,
    pane_pid: { type: 'integer', exclusiveMinimum: 0 }, pane_started: string })
  return { name: 'agent_auth', inputSchema: {
    type: 'object', required: ['harness', 'action'], properties: {
      harness: { enum: ['claude-code'] }, action: { enum: ['start', 'status', 'cancel', 'respond'] },
      session_id: string, relogin: { type: 'boolean' }, expected_binding: binding,
      expected_prompt_digest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      response: { oneOf: [closed({ kind: { const: 'authorization_code' }, value: {
        type: 'string', minLength: 1, maxLength: 8192, pattern: '^[!-~]+$' } }),
      closed({ kind: { const: 'choice' }, id: { type: 'string', pattern: '^option-[1-9]$' } })] },
    },
  }, outputSchema: closed({ schema: { const: 'aiterm.agent-auth-result.v1' }, harness: { enum: ['claude-code'] },
    status: { enum: ['waiting', 'authenticated', 'blocked', 'failed'] }, session_id: nullable, url: nullable,
    user_code: nullable, input_required: { type: 'boolean' }, message: nullable,
    auth_ui: closed({ schema: { const: 'aiterm.auth-ui.v1' },
      stage: { enum: ['open_url', 'device_code', 'paste_code', 'select', 'waiting', 'complete', 'failed', 'unavailable'] },
      title: string, message: string, binding: { anyOf: [binding, { type: 'null' }] }, url: nullable,
      user_code: nullable, input: { enum: ['authorization_code', 'choice', null] }, prompt_digest: nullable,
      choices: { type: 'array', items: closed({ id: string, label: string }) },
    }),
  }) }
}
