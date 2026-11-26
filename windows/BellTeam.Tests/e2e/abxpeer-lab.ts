// scratch (Anis, abx-peer-proof-windows): a small control server so a C# test can drive the connector side and the lab phone of the dev server.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeDataChannel from "node-datachannel";
import { startPairingBinding } from "@kitepon/peer-channel/pairing";
import { labAdmit, labApprove, labRemove } from "../../server/src/dev-approve.ts";
import { writeJsonFile } from "../src/config.ts";
import { startDaemonPeerChannel } from "../src/daemon.ts";
import { LocalApi } from "../src/local-api.ts";
import { admissionFile } from "../src/pc-mode.ts";
import { loadOrCreateKeys } from "../src/pc-keys.ts";

const dir = mkdtempSync(join(tmpdir(), "abxpeer-lab-"));
process.env.APPROVAL_BOX_HOME = join(dir, "home");
const url = process.env.DEV_URL ?? "http://127.0.0.1:8788";
const dataDir = process.env.DEV_DATA!;
const port = Number(process.env.LAB_PORT ?? 8799);
let pc: Awaited<ReturnType<typeof startDaemonPeerChannel>> = undefined as never;
let api: LocalApi;

const routes: Record<string, (b: any) => Promise<unknown>> = {
  "POST /pair": async () => {
    const started = await (await fetch(url + "/connector/v1/pairing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_name: "lab-body", os: "linux", clients: ["claude-code"] }) })).json() as { pairing_id: string; code: string; poll_secret: string };
    const binding = startPairingBinding(await loadOrCreateKeys());
    const approve = labApprove({ text: binding.qrText(started.code), url, dataDir });
    let token = "";
    for (let i = 0; i < 60 && !token; i++) {
      const r = await (await fetch(url + "/connector/v1/pairing/" + started.pairing_id, { headers: { "x-poll-secret": started.poll_secret } })).json() as { status: string; token?: string };
      if (r.status === "claimed" && r.token) token = r.token; else await new Promise((r2) => setTimeout(r2, 500));
    }
    const info = await (await fetch(url + "/connector/v1/connection", { headers: { authorization: "Bearer " + token } })).json() as { connection_id: string; me: { user_id: string } };
    const [admission] = await Promise.all([binding.complete({ server: { url, headers: { authorization: "Bearer " + token } }, account: info.me.user_id, connectionId: info.connection_id }), approve]);
    writeJsonFile(join(dir, "home", "config.json"), { server: url, token, connection_id: info.connection_id });
    writeJsonFile(admissionFile(), admission);
    pc = await startDaemonPeerChannel({ server: url, token }, (l) => console.log("pc:", l), undefined, undefined, () => ({ schema: "approval-box.daemon-status.v1", mode: "pc", paired: true, reason: "running", version: "test", pid: process.pid }));
    if (!pc) throw new Error("daemon peer channel did not start");
    api = new LocalApi();
    return { paired: true, connection_id: info.connection_id };
  },
  "POST /request": async (b) => {
    const ids: string[] = [];
    for (const img of b.images ?? []) ids.push((await api.uploadRequestImage(Buffer.from(img.data, "base64"), img.name, img.type)).id);
    const body = { title: b.title, context: b.context ?? "", options: b.options, requester: "lab", session_label: "lab", client: "claude-code", route: { channel_id: "c-lab", harness: "other" }, ...(ids.length ? { request_attachment_ids: ids } : {}) };
    const first = await api.call("POST", "/decisions", body).catch((e: any) => e);
    const d = await api.call<{ decision_id: string }>("POST", "/decisions", first?.body?.check_token ? { ...body, check_token: first.body.check_token } : body);
    return d;
  },
  "POST /decision": async (b) => api.call("GET", "/decisions/" + b.id),
  "POST /deliveries": async () => api.call("GET", "/deliveries"),
  "POST /admit": async (b) => labAdmit({ text: b.text, url, dataDir }),
  "POST /remove": async (b) => labRemove({ keyId: b.key_id, url, dataDir }),
  "POST /stop": async () => { setTimeout(async () => { await pc?.stop(); nodeDataChannel.cleanup(); process.exit(0); }, 200); return { stopping: true }; },
};

createServer(async (req, res) => {
  let text = ""; for await (const c of req) text += c;
  const key = req.method + " " + req.url;
  try {
    const out = await (routes[key] ?? (async () => { throw Object.assign(new Error("no route " + key), { code: "no_route" }); }))(text ? JSON.parse(text) : {});
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  } catch (e: any) {
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.code ?? e.message, message: String(e.message ?? e), body: e.body }));
  }
}).listen(port, "127.0.0.1", () => console.log("lab control on", port));
