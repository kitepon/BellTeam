// scratch (Anis, abx-peer-proof-windows, keyhole-child part): the lab PARENT A is a login-billing keyholes parent (keys/start), the first device of a new entry,
// holding the pc/1 registry; it approves the connector's PC1PAIR, adds the Windows child B (lbk1 add), admits B's peer offer and removes B. A C# test drives it over a control port.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { b64url, bindingTag, checkBindingTag, equal, fingerprint, fromB64url, fromJson, generateSealKey, generateSigningKey, join as lpJoin, keyId, parseBody, parseQrText, parseTypedCode, signSnapshot, snapshotHash, toJson, utf8, type DeviceEntry, type SnapshotBody } from "@kitepon/peer-channel";
import { startPairingBinding, verifyIdOf } from "@kitepon/peer-channel/pairing";
import { TestDevice } from "@kitepon/peer-channel/testing";
import { makeDevice, parentAdd, type Device } from "../../server/test/keyhole-signer.ts";
import { writeJsonFile } from "../src/config.ts";
import { startDaemonPeerChannel } from "../src/daemon.ts";
import { LocalApi } from "../src/local-api.ts";
import { admissionFile } from "../src/pc-mode.ts";
import { loadOrCreateKeys } from "../src/pc-keys.ts";

const dir = mkdtempSync(join(tmpdir(), "abxchild-lab-"));
process.env.APPROVAL_BOX_HOME = join(dir, "home");
const url = process.env.DEV_URL ?? "http://127.0.0.1:8788";
const port = Number(process.env.LAB_PORT ?? 8798);
const EMPTY = { key_id: "", sig_pub: "", seal_pub: "", connection_id: "", added_at: 0, added_by: "" };

// Every fetch that names a keyhole device in x-lab-keyhole is signed here (a signed request is used once, so each call gets its own).
const devices = new Map<string, Device>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const who = h.get("x-lab-keyhole");
  if (!who) return realFetch(input, init);
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  h.delete("x-lab-keyhole");
  h.set("login-billing-key", await devices.get(who)!.sign(init?.method ?? "GET", u.pathname + u.search, typeof init?.body === "string" ? init.body : ""));
  return realFetch(input, { ...init, headers: h });
}) as typeof fetch;

const asA = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(url + path, { method, headers: { "x-lab-keyhole": "A", "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json().catch(() => ({})) as Record<string, any>;
  return { status: res.status, json };
};
const need = async (step: string, p: Promise<{ status: number; json: Record<string, any> }>, ok = [200]) => { const r = await p; if (!ok.includes(r.status)) throw Object.assign(new Error(step + " answered " + r.status + " " + JSON.stringify(r.json)), { code: step + "_" + r.status }); return r.json; };

let A: Device; let entry = ""; let head: any; let pc: any; let api: LocalApi;
const sign = generateSigningKey(); let seal: Awaited<ReturnType<typeof generateSealKey>>;
const openA = async (extra?: ConstructorParameters<typeof TestDevice>[3], opts?: ConstructorParameters<typeof TestDevice>[4]) => {
  const access = { url, headers: { "x-lab-keyhole": "A", "login-billing-key": await A.sign("GET", "/pc/v1/signal") } as Record<string, string> };
  const d = new TestDevice(access, sign, seal, extra ?? EMPTY, opts);
  await d.open(); return d;
};
const headBody = () => parseBody(fromJson(head).body)!;

const routes: Record<string, (b: any) => Promise<unknown>> = {
  // A = the first device of a new entry: keyholes parent, genesis registry, the connector paired and approved by A.
  "POST /start": async () => {
    A = await makeDevice({ origin: url }); devices.set("A", A);
    entry = (await need("start", asA("POST", "/v1/keys/start", { role: "parent" }))).entry;
    const me = await need("me", asA("GET", "/v1/me"));
    seal = await generateSealKey();
    const now = Date.now();
    const mine: DeviceEntry = { key_id: b64url(sign.id), sig_pub: b64url(sign.pub), seal_pub: b64url(seal.pub), platform: "ios", protection: "hardware", added_at: now - 1000, added_by: b64url(sign.id) };
    const body: SnapshotBody = { v: "pc1-registry", account: me.user_id ?? entry, version: 1, prev: [], created_at: now, devices: [mine], connectors: [], removed: [] };
    head = toJson(signSnapshot(body, sign));
    await need("registry", asA("PUT", "/pc/v1/registry", head), [204]);
    // the connector pairs; A claims the pairing and approves its keys (contract 5.4)
    const started = await (await realFetch(url + "/connector/v1/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "lab-body", os: "linux", clients: ["claude-code"] }) })).json() as any;
    const binding = startPairingBinding(await loadOrCreateKeys());
    const text = binding.qrText(started.code);
    const found = await need("lookup", asA("GET", "/v1/pairing/lookup?code=" + encodeURIComponent(started.code)));
    await need("claim", asA("POST", "/v1/pairing/" + found.pairing_id + "/claim", found.client ? { confirm_client: found.client } : {}));
    let token = "";
    for (let i = 0; i < 60 && !token; i++) { const r = await (await realFetch(url + "/connector/v1/pairing/" + started.pairing_id, { headers: { "x-poll-secret": started.poll_secret } })).json() as any; if (r.status === "claimed" && r.token) token = r.token; else await new Promise((r2) => setTimeout(r2, 300)); }
    const info = await (await realFetch(url + "/connector/v1/connection", { headers: { authorization: "Bearer " + token } })).json() as any;
    const dev = await openA();
    const [admission] = await Promise.all([
      binding.complete({ server: { url, headers: { authorization: "Bearer " + token } }, account: info.me.user_id, connectionId: info.connection_id }),
      dev.approveConnector({ text, registry: { body: headBody(), hash: snapshotHash(fromJson(head)) } }).then((s) => { head = s; }),
    ]);
    dev.close();
    writeJsonFile(join(dir, "home", "config.json"), { server: url, token, connection_id: info.connection_id });
    writeJsonFile(admissionFile(), admission);
    pc = await startDaemonPeerChannel({ server: url, token }, (l: string) => console.log("pc:", l), undefined, undefined, () => ({ schema: "approval-box.daemon-status.v1", mode: "pc", paired: true, reason: "running", version: "test", pid: process.pid }));
    if (!pc) throw new Error("daemon peer channel did not start");
    api = new LocalApi();
    return { entry, user_id: me.user_id, connection_id: info.connection_id };
  },
  // the lbk1 add A signs for the child's keyhole public key; the child sends it itself (keys/accept)
  "POST /add": async (b) => parentAdd(A, b.pub, "child"),
  // A admits the child's peer offer (contract 5.3), like labAdmit but A is a keyholes parent
  "POST /admit": async (b) => {
    const qr = parseQrText(String(b.text).trim()); const typed = qr ? null : parseTypedCode(b.text);
    if ((qr && qr.kind !== "verify") || (!qr && !typed)) throw Object.assign(new Error("not a PC1VERIFY text"), { code: "bad_text" });
    const secret = qr ? qr.secret : typed!; const verifyId = qr?.kind === "verify" ? qr.verifyId : verifyIdOf(secret);
    const device = await openA();
    const signal = (what: string) => Promise.race([device.nextSignal(), new Promise<never>((_, no) => setTimeout(() => no(Object.assign(new Error("no " + what), { code: "starter_silent" })), 30000).unref())]);
    try {
      device.socket.send({ type: "verify.join", verify_id: verifyId });
      const joined = await signal("verify.joined");
      if (joined.type !== "verify.joined" || joined.verify_id !== verifyId) throw Object.assign(new Error("verify.join: " + (joined.code ?? joined.type)), { code: "verify_" + (joined.code ?? joined.type) });
      let starter; do starter = await signal("pc1-join"); while (!(starter.type === "signal" && starter.verify_id === verifyId && starter.env?.dir === "starter"));
      const nonce = fromB64url(starter.env.nonce); const joinPayload = fromB64url(starter.env.payload);
      if (!checkBindingTag(secret, "starter", nonce, joinPayload, fromB64url(starter.env.tag))) throw Object.assign(new Error("tag"), { code: "binding_failed" });
      const j = JSON.parse(new TextDecoder().decode(joinPayload));
      if (j.purpose !== "join") throw Object.assign(new Error("not a join"), { code: "binding_failed" });
      if (!(Number(j.expires_at) > Date.now())) throw Object.assign(new Error("expired"), { code: "binding_expired" });
      if (qr && !equal(fingerprint(fromB64url(j.sig_pub), fromB64url(j.seal_pub)), qr.fingerprint)) throw Object.assign(new Error("fingerprint"), { code: "binding_failed" });
      const at = Date.now(); const hb = headBody();
      const e: DeviceEntry = { key_id: b64url(keyId(fromB64url(j.sig_pub))), sig_pub: j.sig_pub, seal_pub: j.seal_pub, platform: j.platform, protection: j.protection, added_at: at, added_by: b64url(sign.id) };
      const body: SnapshotBody = { ...hb, version: hb.version + 1, prev: [b64url(snapshotHash(fromJson(head)))], created_at: at, devices: [...hb.devices, e] };
      const snap = toJson(signSnapshot(body, sign));
      await need("registry", asA("PUT", "/pc/v1/registry", snap), [204]); head = snap;
      const admit = utf8(JSON.stringify({ v: "pc/1", purpose: "admit", join_nonce: j.nonce, account: hb.account, registry_version: body.version, registry_hash: b64url(snapshotHash(fromJson(snap))), approver_key_id: b64url(sign.id), approver_sig_pub: b64url(sign.pub), expires_at: at + 5 * 60000 }));
      device.socket.send({ type: "signal", verify_id: verifyId, to: joined.peer, env: { dir: "approver", nonce: starter.env.nonce, payload: b64url(admit), tag: b64url(bindingTag(secret, "approver", nonce, lpJoin(joinPayload, admit))) } });
      return { admitted: true, key_id: e.key_id, platform: e.platform, registry_version: body.version };
    } finally { device.close(); }
  },
  // A removes the child: out of the registry (tombstone), then its keyhole (keys/others)
  "POST /remove": async (b) => {
    const hb = headBody(); const at = Date.now();
    if (!hb.devices.some((d) => d.key_id === b.key_id)) throw Object.assign(new Error("device unknown"), { code: "device_unknown" });
    const body: SnapshotBody = { ...hb, version: hb.version + 1, prev: [b64url(snapshotHash(fromJson(head)))], created_at: at, devices: hb.devices.filter((d) => d.key_id !== b.key_id), removed: [...hb.removed, { key_id: b.key_id, removed_at: at, removed_by: b64url(sign.id) }] };
    const snap = toJson(signSnapshot(body, sign));
    await need("registry", asA("PUT", "/pc/v1/registry", snap), [204]); head = snap;
    const others = await need("others", asA("POST", "/v1/keys/others", {}));
    return { registry_version: body.version, keyholes_removed: others.removed };
  },
  "POST /request": async (b) => {
    const ids: string[] = [];
    for (const img of b.images ?? []) ids.push((await api.uploadRequestImage(Buffer.from(img.data, "base64"), img.name, img.type)).id);
    const body = { title: b.title, context: b.context ?? "", options: b.options, requester: "lab", session_label: "lab", client: "claude-code", route: { channel_id: "c-lab", harness: "other" }, ...(ids.length ? { request_attachment_ids: ids } : {}) };
    const first = await api.call("POST", "/decisions", body).catch((e: any) => e);
    return api.call("POST", "/decisions", first?.body?.check_token ? { ...body, check_token: first.body.check_token } : body);
  },
  "POST /decision": async (b) => api.call("GET", "/decisions/" + b.id),
  "POST /stop": async () => { setTimeout(async () => { await pc?.stop(); nodeDataChannel.cleanup(); process.exit(0); }, 200); return { stopping: true }; },
};
createServer(async (req, res) => {
  let text = ""; for await (const c of req) text += c;
  try {
    const f = routes[req.method + " " + req.url]; if (!f) throw Object.assign(new Error("no route"), { code: "no_route" });
    const out = await f(text ? JSON.parse(text) : {}); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (e: any) { res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.code ?? e.message, message: String(e.message ?? e), body: e.body })); }
}).listen(port, "127.0.0.1", () => console.log("child lab control on", port));
