// Test harness for DeviceRuntimeE2eTests (windows/BellTeam.Tests). Copy into a peer-channel checkout's ts/ (built: npm ci && npm run build; contract 0.5.x), then:
//   node harness-rt.mjs <file>        (writes <file>, serves on 127.0.0.1:18898, answers for up to 90 s)
//   PC_E2E_RUNTIME_FILE=<file> dotnet test windows/BellTeam.Tests --filter DeviceRuntimeE2eTests
// A TS connector files one approval-box/decision@1 request; the C# DeviceRuntime must receive it, hold it, answer it and see the result.
import { createECDH, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { b64url, hex } from "./dist/src/bytes.js";
import { signingKeyFromScalar, generateSigningKey } from "./dist/src/keys.js";
import { generateSealKey } from "./dist/src/envelope.js";
import { Connector } from "./dist/src/connector/connector.js";
import { devToken, fakeAuthenticate, FakeWake } from "./dist/src/dev/fake.js";
import { MemoryMirrorStore } from "./dist/src/server/mirror.js";
import { createServerPart, listen } from "./dist/src/server/signaling.js";
import { putMirror } from "./dist/src/signal-client.js";
import { signSnapshot, snapshotHash, toJson } from "./dist/src/snapshot.js";

const K = "acct-win", out = process.argv[2];
const sha = (s) => createHash("sha256").update(s).digest();
const point = (d) => { const e = createECDH("prime256v1"); e.setPrivateKey(d); return e.getPublicKey(null, "uncompressed"); };
const dir = mkdtempSync(join(tmpdir(), "pc-win-e2e-"));
const part = createServerPart({ authenticate: async (req) => fakeAuthenticate(req), wake: new FakeWake().wake, store: new MemoryMirrorStore(), turn: { secret: "t", urls: [] } });
const srv = await listen(part, 18898);
const devSigD = sha("windows e2e device sign"), devSealD = sha("windows e2e device seal");
const devSign = signingKeyFromScalar(devSigD), devSealPub = point(devSealD);
const access = { url: srv.url, headers: devToken("device", K, "pid-win", "store") };
const now = Date.now();
const cSign = generateSigningKey(), cSeal = await generateSealKey();
const d = { key_id: b64url(devSign.id), sig_pub: b64url(devSign.pub), seal_pub: b64url(devSealPub), platform: "windows", protection: "os_store", added_at: now - 1000, added_by: b64url(devSign.id) };
const conEntry = { key_id: b64url(cSign.id), sig_pub: b64url(cSign.pub), seal_pub: b64url(cSeal.pub), connection_id: "conn-win", added_at: now, added_by: d.key_id };
const body = (version, connectors, prev) => ({ v: "pc1-registry", account: K, version, prev, created_at: now, devices: [d], connectors, removed: [] });
const genesis = signSnapshot(body(1, [], []), devSign);
console.log("genesis", JSON.stringify(await putMirror(access, toJson(genesis))));
const v2 = signSnapshot(body(2, [conEntry], [b64url(snapshotHash(genesis))]), devSign);
console.log("v2", JSON.stringify(await putMirror(access, toJson(v2))));
const answers = [];
const connector = new Connector({
  server: { url: srv.url, headers: devToken("connector", K, "conn-win") }, connectionId: "conn-win", account: K, keys: { sign: cSign, seal: cSeal },
  admission: { snapshot: toJson(v2), hash: hex(snapshotHash(v2)) }, product: ["approval-box/decision@1"],
  validate: (schema, _c, rid) => schema === "approval-box/answer@1" && typeof rid === "string" && rid.length > 0,
  onClosed: (rid, status) => console.log("CLOSED", rid, status), onHold: (rid, held) => console.log("HOLD", rid, held),
  onError: (c) => console.log("CONNECTOR_ERROR", c), onAnswer: (a) => { answers.push(a); console.log("ANSWER", JSON.stringify(a)); }, onDeviceAdded: () => {}, stateDir: join(dir, "connector"),
});
connector.start();
const rid = connector.request({ schema: "approval-box/decision@1", content: { decision_id: "K-E2E001", title: "runtime e2e", context: "本文", options: [{ id: "yes", label: "はい" }, { id: "no", label: "いいえ" }], urgency: "normal", source: { client: "claude-code", session_label: "e2e", work_label: "e2e" }, created_at: new Date().toISOString(), version: 1 } });
writeFileSync(out, JSON.stringify({ url: srv.url, authorization: access.headers.authorization, rid, registry_hash: b64url(snapshotHash(v2)),
  device: { sig_priv: hex(devSigD), sig_pub: hex(devSign.pub), seal_priv: hex(devSealD), seal_pub: hex(devSealPub) }, connector: { key_id: conEntry.key_id, sig_pub: conEntry.sig_pub, seal_pub: conEntry.seal_pub, connection_id: conEntry.connection_id } }));
console.log("READY", rid);
const t0 = Date.now();
while (Date.now() - t0 < 90000 && answers.length === 0) await new Promise((r) => setTimeout(r, 200));
await new Promise((r) => setTimeout(r, 3000));
connector.stop(); await srv.close(); nodeDataChannel.cleanup();
console.log(answers.length ? "DONE answered" : "DONE timeout");
process.exit(0);
