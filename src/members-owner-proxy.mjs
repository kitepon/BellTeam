export function createMembersOwnerProxy({ port = 4181, request = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MEMBERS_OWNER_PORT_INVALID')
  return {
    async updateUserRules(text) {
      if (typeof text !== 'string' || text.length > 20000 || text.includes('\0')) throw new Error('USER_RULES_INVALID')
      const response = await request(`http://127.0.0.1:${port}/internal/members-owner`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'rules.update', params: { text } }),
      })
      if (!response.ok) throw Object.assign(new Error('MEMBERS_OWNER_UNAVAILABLE'), { code: 'MEMBERS_OWNER_UNAVAILABLE', status: response.status })
      const value = await response.json()
      if (typeof value?.text !== 'string') throw new Error('MEMBERS_OWNER_RESULT_INVALID')
      return value.text
    },
  }
}
