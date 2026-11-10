// The remote seat listener's own port (remote-seat-ingress.md RS05). 4182 is the diagnostics admin port (0.0.0.0, host
// 18892); sharing it made the seat listener fail to bind and every remote seat MCP reach the admin server (401).
// Aiterm's serve forwards to the same env (BELLTEAM_REMOTE_SEAT_PORT ?? its own default), so terminals pass it explicitly.
export const remoteSeatPort = (environment = process.env) => Number(environment.BELLTEAM_REMOTE_SEAT_PORT ?? 4183)
