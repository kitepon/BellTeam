// @kitepon/login-billing 0.16.0 login-billing-home.mjs

// dist/server/crypto.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var utf8 = (s) => encoder.encode(s);
function b64u(bytes) {
  let s = "";
  for (const byte of bytes)
    s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text))
    throw new Error("base64url");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++)
    out[i] = s.charCodeAt(i);
  return out;
}
var randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
var buf = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf(data)));
}
var hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", buf(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, buf(data)));
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let d = 0;
  for (let i = 0; i < a.length; i++)
    d |= a[i] ^ b[i];
  return d === 0;
}

// dist/home/home.js
var HOME_STATUS = {
  LOGIN_INPUT_INVALID: 400,
  NONCE_INVALID: 400,
  UNAUTHORIZED: 401,
  AUDIENCE_UNKNOWN: 403,
  SETUP_CODE_REQUIRED: 403,
  LOGIN_CODE_INVALID: 403,
  PROOF_REFUSED: 403,
  NOT_OWNER_ACCOUNT: 403,
  SESSION_NOT_FOUND: 404,
  LOGIN_RATE_LIMITED: 429,
  LOGIN_OPERATOR_UNREACHABLE: 503,
  SESSION_STORE_UNAVAILABLE: 503
};
var HomeError = class extends Error {
  code;
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "HomeError";
  }
};
var fail = (code) => {
  throw new HomeError(code);
};
var NONCE_MS = 12e4;
var SETUP_MS = 10 * 6e4;
var CHECK_MS = 10 * 6e4;
var IDLE_MS = 14 * 864e5;
var ID22 = /^[A-Za-z0-9_-]{22}$/;
function exactOrigin(a) {
  if (typeof a !== "string" || a.length > 512)
    return false;
  try {
    const u = new URL(a);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === a;
  } catch {
    return false;
  }
}
var stateOf = (ents) => ents.length ? "active" : "none";
var cleanEnts = (v) => Array.isArray(v) ? v.filter((e) => e && typeof e.productId === "string").map((e) => ({ productId: e.productId, kind: String(e.kind), store: String(e.store), ...typeof e.expiresAt === "string" ? { expiresAt: e.expiresAt } : {} })) : [];
function createHomePart(config) {
  const now = config.now ?? Date.now;
  const rawFetch = config.fetch ?? ((...a) => fetch(...a));
  const operator = config.operator.replace(/\/+$/, "");
  const limits = { nonce: 30, prove: 10, console: 10, ...config.limits };
  let state;
  let setup;
  const consoleCodes = /* @__PURE__ */ new Map();
  const counters = /* @__PURE__ */ new Map();
  let line = Promise.resolve();
  async function current() {
    if (state)
      return state;
    let loaded;
    try {
      loaded = await config.store.load();
    } catch {
      return fail("SESSION_STORE_UNAVAILABLE");
    }
    if (loaded) {
      state = loaded;
      return state;
    }
    const fresh = { v: 1, owner: null, enforced: false, addresses: [], nonceSecret: b64u(randomBytes(32)), setV: 1, sessions: [] };
    try {
      await config.store.save(fresh);
    } catch {
      return fail("SESSION_STORE_UNAVAILABLE");
    }
    state = fresh;
    return state;
  }
  function mutate(change) {
    const run = line.then(async () => {
      const next = structuredClone(await current());
      const out = change(next);
      next.setV++;
      try {
        await config.store.save(next);
      } catch {
        state = void 0;
        return fail("SESSION_STORE_UNAVAILABLE");
      }
      state = next;
      return out;
    });
    line = run.catch(() => void 0);
    return run;
  }
  function cap(kind, peer) {
    const key = kind + ":" + peer;
    const c = counters.get(key);
    const t = now();
    if (!c || c.until <= t) {
      counters.set(key, { n: 1, until: t + 6e4 });
      if (counters.size > 1e4)
        counters.delete(counters.keys().next().value);
      return;
    }
    if (++c.n > limits[kind])
      fail("LOGIN_RATE_LIMITED");
  }
  const hashHex = async (s) => hex(await sha256(utf8(s)));
  const sameHex = (a, b) => a.length === b.length && constantTimeEqual(utf8(a), utf8(b));
  async function nonceMac(secret, body) {
    return b64u((await hmacSha256(fromB64u(secret), utf8("home-nonce:" + body))).slice(0, 16));
  }
  async function nonce(peer = "") {
    const s = await current();
    cap("nonce", peer);
    const body = now().toString(36) + "." + b64u(randomBytes(12));
    return { nonce: body + "." + await nonceMac(s.nonceSecret, body) };
  }
  async function nonceOk(n) {
    if (typeof n !== "string" || n.length > 128)
      return false;
    const parts = n.split(".");
    if (parts.length !== 3)
      return false;
    const t = parseInt(parts[0], 36);
    if (!Number.isFinite(t) || now() - t > NONCE_MS || t > now() + 5e3)
      return false;
    return sameHex(await nonceMac((await current()).nonceSecret, parts[0] + "." + parts[1]), parts[2]);
  }
  async function operatorCall(path, body) {
    let res;
    try {
      res = await rawFetch(operator + "/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(15e3) });
    } catch {
      return fail("LOGIN_OPERATOR_UNREACHABLE");
    }
    if (res.status >= 300 && res.status < 400 || res.type === "opaqueredirect" || res.status >= 500 || res.status === 429)
      return fail("LOGIN_OPERATOR_UNREACHABLE");
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  async function proveTake(code, audience, n) {
    const r = await operatorCall("prove/take", { code, audience, nonce: n });
    if (r.status !== 200)
      return fail("PROOF_REFUSED");
    const { k, passId, ticket } = r.json;
    if (typeof k !== "string" || typeof passId !== "string" || typeof ticket !== "string")
      return fail("PROOF_REFUSED");
    return { k, passId, ticket, ents: cleanEnts(r.json.entitlements) };
  }
  function validProof(input) {
    if (typeof input?.code !== "string" || !ID22.test(input.code))
      fail("LOGIN_INPUT_INVALID");
    if (!exactOrigin(input.audience))
      fail("LOGIN_INPUT_INVALID");
  }
  async function newSession(kind, appKind, p, tv) {
    const token = b64u(randomBytes(32));
    const t = now();
    const s = {
      id: b64u(randomBytes(16)),
      th: await hashHex(token),
      kind,
      appKind,
      state: p ? stateOf(p.ents) : "none",
      ents: p?.ents ?? [],
      ...p ? { k: p.k, pid: p.passId, ticket: p.ticket } : {},
      ...tv !== void 0 ? { tv } : {},
      created: t,
      lastProof: t,
      lastCheck: t,
      lastUse: t
    };
    return { token, s };
  }
  async function prove(input, peer = "", viaConsole = false) {
    const s0 = await current();
    validProof(input);
    if (typeof input.kind !== "string" || !/^[A-Za-z0-9_.-]{1,32}$/.test(input.kind) || config.kinds && !config.kinds.includes(input.kind))
      fail("LOGIN_INPUT_INVALID");
    if (!await nonceOk(input.nonce))
      fail("NONCE_INVALID");
    const audience = input.audience;
    const binding = s0.owner === null || viaConsole && "console" in (s0.owner ?? {});
    let register = false;
    if (s0.owner === null) {
      if (typeof input.setupCode !== "string" || !input.setupCode)
        fail("SETUP_CODE_REQUIRED");
      if (!setup || setup.until <= now() || !sameHex(await hashHex(input.setupCode), setup.hash))
        fail("LOGIN_CODE_INVALID");
      register = !s0.addresses.includes(audience);
    } else if (!s0.addresses.includes(audience)) {
      fail("AUDIENCE_UNKNOWN");
    }
    cap("prove", peer);
    if (register)
      await mutate((s2) => {
        if (!s2.addresses.includes(audience))
          s2.addresses.push(audience);
      });
    const p = await proveTake(input.code, audience, input.nonce);
    const owner = (await current()).owner;
    if (!binding && !(owner && "k" in owner && owner.k === p.k))
      fail("NOT_OWNER_ACCOUNT");
    const { token, s } = await newSession("account", input.kind, p, typeof input.ticketFor === "string" && utf8(input.ticketFor).length <= 64 ? input.ticketFor : void 0);
    await mutate((st) => {
      if (binding) {
        st.owner = { k: p.k };
        st.enforced = true;
      }
      st.sessions.push(s);
    });
    if (binding)
      setup = void 0;
    return { token, sessionId: s.id, state: s.state, entitlements: s.ents, events: [{ type: "session.created", sessionId: s.id }] };
  }
  async function reprove(sessionId, input) {
    const st = await current();
    const s = st.sessions.find((x) => x.id === sessionId && x.kind === "account") ?? fail("SESSION_NOT_FOUND");
    validProof(input);
    if (!await nonceOk(input.nonce))
      fail("NONCE_INVALID");
    if (!st.addresses.includes(input.audience))
      fail("AUDIENCE_UNKNOWN");
    const p = await proveTake(input.code, input.audience, input.nonce);
    if (p.k !== s.k)
      fail("NOT_OWNER_ACCOUNT");
    const before = s.state;
    const next = await mutate((x) => {
      const t = x.sessions.find((y) => y.id === sessionId) ?? fail("SESSION_NOT_FOUND");
      Object.assign(t, { pid: p.passId, ticket: p.ticket, ents: p.ents, state: stateOf(p.ents), lastProof: now(), lastCheck: now(), lastUse: now() });
      if (typeof input.ticketFor === "string" && utf8(input.ticketFor).length <= 64)
        t.tv = input.ticketFor;
      return t;
    });
    const events = next.state !== before ? [{ type: "entitlement.changed", sessionId, state: next.state }] : [];
    return { sessionId, state: next.state, entitlements: next.ents, events };
  }
  function entitlement({ sessionId }) {
    const s = state?.sessions.find((x) => x.id === sessionId);
    if (!state)
      return { state: "unknown", entitlements: [] };
    if (!s || s.kind === "console")
      return { state: "none", entitlements: [] };
    return { state: s.state, entitlements: s.ents };
  }
  function pushTicket(q) {
    const s = state?.sessions.find((x) => q.sessionId !== void 0 ? x.id === q.sessionId : x.tv !== void 0 && x.tv === q.value);
    return s?.ticket && s.tv !== void 0 ? { ticket: s.ticket, value: s.tv } : void 0;
  }
  async function sessions() {
    return (await current()).sessions.map((s) => ({ id: s.id, kind: s.kind, appKind: s.appKind, state: s.state, created: new Date(s.created).toISOString(), lastUse: new Date(s.lastUse).toISOString() }));
  }
  async function endSession(sessionId) {
    const ended = await mutate((s) => {
      const before = s.sessions.length;
      s.sessions = s.sessions.filter((x) => x.id !== sessionId);
      return before !== s.sessions.length;
    });
    if (!ended)
      fail("SESSION_NOT_FOUND");
    return [{ type: "session.ended", sessionId }];
  }
  async function addresses() {
    return [...(await current()).addresses];
  }
  async function addAddress(address) {
    if (!exactOrigin(address))
      fail("LOGIN_INPUT_INVALID");
    return mutate((s) => {
      if (!s.addresses.includes(address))
        s.addresses.push(address);
      return [...s.addresses];
    });
  }
  async function removeAddress(address) {
    return mutate((s) => {
      s.addresses = s.addresses.filter((a) => a !== address);
      return [...s.addresses];
    });
  }
  async function setupCode() {
    await current();
    const code = b64u(randomBytes(8));
    setup = { hash: await hashHex(code), until: now() + SETUP_MS };
    return { code, expiresAt: new Date(setup.until).toISOString() };
  }
  async function status() {
    const s = await current();
    return { capability: "login-billing-home/1", bound: s.owner !== null, enforced: s.enforced };
  }
  async function consoleIssue() {
    await current();
    const code = b64u(randomBytes(8));
    consoleCodes.set(await hashHex(code), now() + SETUP_MS);
    return { code };
  }
  async function consoleLogin(code, peer = "") {
    await current();
    cap("console", peer);
    if (typeof code !== "string" || code.length > 64)
      fail("LOGIN_INPUT_INVALID");
    const h = await hashHex(code);
    const until = consoleCodes.get(h);
    consoleCodes.delete(h);
    if (!until || until <= now())
      fail("LOGIN_CODE_INVALID");
    const { token, s } = await newSession("console", "console");
    await mutate((st) => {
      if (st.owner === null) {
        st.owner = { console: true };
        st.enforced = true;
      }
      st.sessions.push(s);
    });
    return { token, sessionId: s.id, events: [{ type: "session.created", sessionId: s.id }] };
  }
  async function consoleList() {
    return (await sessions()).filter((s) => s.kind === "console");
  }
  const consoleRevoke = (sessionId) => endSession(sessionId);
  async function resetOwner() {
    const ended = await mutate((s) => {
      const ids = s.sessions.map((x) => x.id);
      s.sessions = [];
      s.owner = null;
      s.enforced = true;
      return ids;
    });
    return ended.map((sessionId) => ({ type: "session.ended", sessionId }));
  }
  async function sweep({ used = [], streaming = [], budgetMs = 5e3 } = {}) {
    const start = now();
    const st = await current();
    const events = [];
    const inUse = /* @__PURE__ */ new Set([...used, ...streaming]);
    const t0 = now();
    const updates = /* @__PURE__ */ new Map();
    const ends = /* @__PURE__ */ new Set();
    for (const s of st.sessions) {
      const lastUse = inUse.has(s.id) ? t0 : s.lastUse;
      if (lastUse !== s.lastUse)
        updates.set(s.id, { lastUse });
      if (t0 - lastUse > IDLE_MS) {
        ends.add(s.id);
        continue;
      }
      if (s.kind !== "account" || !s.ticket)
        continue;
      const due = (inUse.has(s.id) || lastUse > s.lastCheck) && t0 - s.lastCheck >= CHECK_MS;
      if (!due || now() - start > budgetMs)
        continue;
      let answer;
      try {
        answer = await operatorCall("ticket/check", { ticket: s.ticket });
      } catch {
        answer = void 0;
      }
      if (answer?.status === 200) {
        const ents = cleanEnts(answer.json.entitlements);
        const next = stateOf(ents);
        updates.set(s.id, { ...updates.get(s.id), ents, state: next, lastCheck: now() });
        if (next !== s.state)
          events.push({ type: "entitlement.changed", sessionId: s.id, state: next });
      } else if (answer && answer.status === 401) {
        ends.add(s.id);
      } else if (config.cannotJudgeMs !== "no limit" && t0 - s.lastCheck > (config.cannotJudgeMs ?? 24 * 36e5) && s.state !== "unknown") {
        updates.set(s.id, { ...updates.get(s.id), state: "unknown" });
        events.push({ type: "entitlement.changed", sessionId: s.id, state: "unknown" });
      }
    }
    if (updates.size || ends.size) {
      await mutate((x) => {
        x.sessions = x.sessions.filter((s) => !ends.has(s.id));
        for (const s of x.sessions)
          Object.assign(s, updates.get(s.id) ?? {});
      });
    }
    for (const sessionId of ends)
      events.push({ type: "session.ended", sessionId });
    return { events };
  }
  function publishedSet() {
    return { v: 1, hashes: Object.fromEntries((state?.sessions ?? []).map((s) => [s.th, s.id])) };
  }
  async function sessionOf(headers) {
    const auth = headers["authorization"] ?? headers["Authorization"];
    if (!auth || !/^bearer /i.test(auth))
      return void 0;
    const th = await hashHex(auth.slice(7).trim());
    return (await current()).sessions.find((s) => s.th === th);
  }
  return {
    status,
    setupCode,
    nonce,
    prove,
    reprove,
    entitlement,
    pushTicket,
    sessions,
    endSession,
    addresses,
    addAddress,
    removeAddress,
    consoleIssue,
    consoleLogin,
    consoleList,
    consoleRevoke,
    resetOwner,
    sweep,
    publishedSet,
    sessionOf
  };
}

// dist/home/handler.js
var MAX_BODY = 16 * 1024;
function createHomeHandler(part) {
  const json = (status, body, events = []) => ({ status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body), events });
  function parse(body) {
    if (!body)
      return {};
    if (body.length > MAX_BODY)
      throw new HomeError("LOGIN_INPUT_INVALID");
    let v;
    try {
      v = JSON.parse(body);
    } catch {
      throw new HomeError("LOGIN_INPUT_INVALID");
    }
    if (!v || typeof v !== "object" || Array.isArray(v))
      throw new HomeError("LOGIN_INPUT_INVALID");
    return v;
  }
  async function route(r) {
    const path = r.path.replace(/^\/+|\/+$/g, "");
    const peer = r.peer ?? "";
    const m = r.method.toUpperCase();
    if (m === "GET" && path === "session") {
      const st = await part.status();
      const s2 = await part.sessionOf(r.headers);
      return json(200, { ...st, ...s2 ? { session: { id: s2.id, kind: s2.kind, state: s2.state, entitlements: s2.ents } } : {} });
    }
    if (m === "POST" && path === "login/nonce")
      return json(200, await part.nonce(peer));
    if (m === "POST" && path === "login/prove") {
      const caller = await part.sessionOf(r.headers);
      const { events, ...out } = await part.prove(parse(r.body), peer, caller?.kind === "console");
      return json(200, out, events);
    }
    if (m === "POST" && path === "login/console") {
      const { events, ...out } = await part.consoleLogin(parse(r.body).code, peer);
      return json(200, out, events);
    }
    const s = await part.sessionOf(r.headers);
    if (!s)
      throw new HomeError("UNAUTHORIZED");
    if (m === "POST" && path === "session/prove") {
      if (s.kind !== "account")
        throw new HomeError("LOGIN_INPUT_INVALID");
      const { events, ...out } = await part.reprove(s.id, parse(r.body));
      return json(200, out, events);
    }
    if (m === "GET" && path === "sessions")
      return json(200, { sessions: (await part.sessions()).map((x) => ({ ...x, current: x.id === s.id })) });
    if (m === "DELETE" && path.startsWith("sessions/"))
      return json(200, { ok: true }, await part.endSession(decodeURIComponent(path.slice(9))));
    if (path === "addresses") {
      if (m === "GET")
        return json(200, { addresses: await part.addresses() });
      const b = parse(r.body);
      if (m === "POST") {
        const address = typeof b.address === "string" ? b.address : void 0;
        if (s.kind !== "console" && address === void 0)
          throw new HomeError("LOGIN_INPUT_INVALID");
        return json(200, { addresses: await part.addAddress(address) });
      }
      if (m === "DELETE") {
        if (s.kind !== "console")
          throw new HomeError("UNAUTHORIZED");
        return json(200, { addresses: await part.removeAddress(String(b.address)) });
      }
    }
    return json(404, { error: "SESSION_NOT_FOUND" });
  }
  return async function handle(r) {
    try {
      return await route(r);
    } catch (e) {
      const code = e instanceof HomeError ? e.code : "SESSION_STORE_UNAVAILABLE";
      return json(HOME_STATUS[code], { error: code });
    }
  };
}

// dist/home/store.js
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
function fileHomeStore(path) {
  return {
    async load() {
      let text;
      try {
        text = await readFile(path, "utf8");
      } catch (e) {
        if (e.code === "ENOENT")
          return void 0;
        throw e;
      }
      return JSON.parse(text);
    },
    async save(state) {
      await mkdir(dirname(path), { recursive: true, mode: 448 });
      const tmp = path + ".tmp";
      await writeFile(tmp, JSON.stringify(state), { mode: 384 });
      await chmod(tmp, 384);
      await rename(tmp, path);
    }
  };
}
export {
  HOME_STATUS,
  HomeError,
  createHomeHandler,
  createHomePart,
  fileHomeStore
};
