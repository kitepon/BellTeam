// Test harness for DeviceAdmissionE2eTests (windows/BellTeam.Tests). Copy into a peer-channel checkout's ts/ (built), then:
//   node harness-admit.mjs <file>     (serves on 127.0.0.1:18897, writes <file>, waits for <file>.in = {"typed":"..."} or {"text":"PC1VERIFY:..."}, admits the device, prints DONE)
//   PC_E2E_ADMIT_FILE=<file> dotnet test windows/BellTeam.Tests --filter DeviceAdmissionE2eTests
// The approver is a verified TS device of account acct-adm (5.3 approver side); the device under test is the starter.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import nodeDataChannel from "node-datachannel";
import { b64url, equal, fromB64url, join, utf8 } from "./dist/src/bytes.js";
import { bindingTag, checkBindingTag } from "./dist/src/binding.js";
import { verifyIdOf } from "./dist/src/connector/pairing.js";
import { generateSealKey } from "./dist/src/envelope.js";
import { parseQrText, parseTypedCode } from "./dist/src/handoff.js";
import { fingerprint, generateSigningKey, keyId } from "./dist/src/keys.js";
import { devToken, fakeAuthenticate, FakeWake } from "./dist/src/dev/fake.js";
import { MemoryMirrorStore } from "./dist/src/server/mirror.js";
import { createServerPart, listen } from "./dist/src/server/signaling.js";
import { putMirror } from "./dist/src/signal-client.js";
import { signSnapshot, snapshotHash, toJson } from "./dist/src/snapshot.js";
import { TestDevice } from "./dist/src/testing/device.js";

const K = "acct-adm", out = process.argv[2];
const part = createServerPart({ authenticate: async (req) => fakeAuthenticate(req), wake: new FakeWake().wake, store: new MemoryMirrorStore(), turn: { secret: "t", urls: [] } });
const srv = await listen(part, 18897);
const apprSign = generateSigningKey(), apprSeal = await generateSealKey();
const access = { url: srv.url, headers: devToken("device", K, "pid-appr", "store") };
const now = Date.now();
const me = { key_id: b64url(apprSign.id), sig_pub: b64url(apprSign.pub), seal_pub: b64url(apprSeal.pub), platform: "ios", protection: "hardware", added_at: now - 1000, added_by: b64url(apprSign.id) };
const genesisBody = { v: "pc1-registry", account: K, version: 1, prev: [], created_at: now, devices: [me], connectors: [], removed: [] };
const genesis = signSnapshot(genesisBody, apprSign);
console.log("genesis", JSON.stringify(await putMirror(access, toJson(genesis))));
const approver = new TestDevice(access, apprSign, apprSeal, {});
await approver.open();
writeFileSync(out, JSON.stringify({ url: srv.url, authorization: devToken("device", K, "pid-win", "signed").authorization, account: K }));
console.log("READY");
const t0 = Date.now();
while (!existsSync(out + ".in") && Date.now() - t0 < 90000) await new Promise((r) => setTimeout(r, 100));
if (!existsSync(out + ".in")) { console.log("DONE timeout"); process.exit(0); }
const input = JSON.parse(readFileSync(out + ".in", "utf8"));
const qr = input.text ? parseQrText(input.text) : null;
const secret = qr?.kind === "verify" ? qr.secret : input.typed ? parseTypedCode(input.typed) : null;
if (!secret) { console.log("DONE bad input"); process.exit(1); }
const verifyId = verifyIdOf(secret);
let joined;
for (const until = Date.now() + 60_000; ;) {
  approver.socket.send({ type: "verify.join", verify_id: verifyId });
  const m = await approver.nextSignal();
  if (m.type === "verify.joined" && m.verify_id === verifyId) { joined = m; break; }
  if (m.type === "error" && m.code === "unknown_verify" && Date.now() < until) { await new Promise((r) => setTimeout(r, 300)); continue; }
  throw new Error("verify.join: " + (m.code ?? m.type));
}
let starter;
do starter = await approver.nextSignal(); while (!(starter.type === "signal" && starter.verify_id === verifyId && starter.env?.dir === "starter"));
const nonce = fromB64url(starter.env.nonce), joinBytes = fromB64url(starter.env.payload);
if (!checkBindingTag(secret, "starter", nonce, joinBytes, fromB64url(starter.env.tag))) throw new Error("binding_failed: starter tag");
const j = JSON.parse(new TextDecoder().decode(joinBytes));
if (qr && !equal(fingerprint(fromB64url(j.sig_pub), fromB64url(j.seal_pub)), qr.fingerprint)) throw new Error("binding_failed: fingerprint");
const at = Date.now();
const body = { ...genesisBody, version: 2, prev: [b64url(snapshotHash(genesis))], created_at: at,
  devices: [...genesisBody.devices, { key_id: b64url(keyId(fromB64url(j.sig_pub))), sig_pub: j.sig_pub, seal_pub: j.seal_pub, platform: j.platform, protection: j.protection, added_at: at, added_by: me.key_id }] };
const snap = signSnapshot(body, apprSign);
const put = await putMirror(access, toJson(snap));
if (!put.ok) throw new Error("mirror " + put.code);
const admit = utf8(JSON.stringify({ v: "pc/1", purpose: "admit", join_nonce: j.nonce, account: K, registry_version: body.version, registry_hash: b64url(snapshotHash(snap)), approver_key_id: me.key_id, approver_sig_pub: me.sig_pub, expires_at: at + 5 * 60_000 }));
approver.socket.send({ type: "signal", verify_id: verifyId, to: joined.peer, env: { dir: "approver", nonce: starter.env.nonce, payload: b64url(admit), tag: b64url(bindingTag(secret, "approver", nonce, join(joinBytes, admit))) } });
console.log("ADMITTED", j.platform, j.protection);
await new Promise((r) => setTimeout(r, 3000));
await srv.close(); nodeDataChannel.cleanup();
console.log("DONE");
process.exit(0);
