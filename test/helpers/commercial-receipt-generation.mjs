// Review-only artificial graph/runtime; no native factory, PTY or real Bot.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const sourceRoot = process.argv[2] ?? fileURLToPath(new URL('../../../repos/aiterm-native-management-release', import.meta.url));
const { FileExecutionStore } = await import(`${sourceRoot}/dist/execution-store.js`);
const { ExecutionService } = await import(`${sourceRoot}/dist/execution-service.js`);
const { executionBindingMeta } = await import(`${sourceRoot}/dist/execution-tools.js`);
import { AitermTransport } from '/app/src/aiterm-transport.mjs';
import { ExecutionBridge } from '/app/src/execution-bridge.mjs';

const root = mkdtempSync('/tmp/centi-generation-');
const A = { session_id: 'review-source', launch_id: 'a'.repeat(32) };
const B = { session_id: 'review-target', launch_id: 'b'.repeat(32) };
const C = { session_id: 'review-target', launch_id: 'c'.repeat(32) };
let target = null;
const store = new FileExecutionStore(root);
const runtime = {
  sourceEvidence: async () => ({ runtime_launch: A, caller_bound: true, invocation_boundary: null }),
  observe: async session => session === A.session_id ? { state: 'present', launch: A }
    : target ? { state: 'present', launch: target } : { state: 'absent' },
  observeSync: session => session === A.session_id ? { state: 'present', launch: A }
    : target ? { state: 'present', launch: target } : { state: 'absent' },
  observeCreatedLaunchSync: () => ({ target, native: { schema: 'aiterm.execution-native.v1', native_id: '$9',
    server: { pid: 9999, started_identity: 'artificial-review-server' } }, initial_prompt: 'none',
    initial_prompt_delivery: null, harness_alive: true, ready: true }),
  completion: async () => ({ state: 'unknown', fence: 'unknown' }),
  close: async () => assert.fail('no native close'),
};
const service = new ExecutionService(store, runtime);
const request = delivery_id => ({ kind: 'delivery', delivery_id, target_session_id: B.session_id });
const oldRequest = request('review-old'), newRequest = request('review-new');
const register = req => service.execute({ action: 'register', source_session_id: A.session_id,
  reservation: { schema: 'aiterm.execution-reservation.v1', request: req,
    source: { launch: A, boundary: null }, target: { session_id: B.session_id, expected_launch_id: null } } });
const meta = req => ({ schema: 'aiterm.execution-ref.v1', request: req });
try {
  await register(oldRequest);
  await service.invoke(meta(oldRequest), 'launch', async () => {
    target = B;
    return { value: {}, target: { launch: B, boundary: null } };
  }, B.session_id);
  // Artificial old harness exit; a separate later request creates C then loses its receipt.
  target = null;
  await register(newRequest);
  await assert.rejects(service.invoke(meta(newRequest), 'launch', async () => {
    target = C;
    throw new Error('artificial lost launch receipt');
  }, C.session_id));
  const client = { async call(name, args) {
    assert.equal(name, 'agent_execution');
    const record = await service.execute(args);
    return { structuredContent: record, _meta: executionBindingMeta(record) };
  } };
  const transport = new AitermTransport({ client, executionBridge: new ExecutionBridge(client) });
  const bot = { id: 'review-bot', session: B.session_id };
  transport.uncertainChanges.set(bot.id, 'agent_launch');
  const fixed = process.argv[3] === 'fixed';
  let handle;
  if (fixed) await assert.rejects(transport.reconcileLaunch(bot, oldRequest, B), { code: 'EXECUTION_UNCONFIRMED' });
  else handle = await transport.reconcileLaunch(bot, oldRequest, B);
  const snapshot = store.snapshot();
  if (handle) assert.deepEqual(handle.binding.target.launch, B);
  assert.deepEqual(target, C);
  assert.equal(snapshot.records.find(r => r.reservation.request.delivery_id === 'review-new').operations.launch, 'unknown');
  assert.equal(snapshot.slots.length, 1);
  assert.equal(transport.uncertainChanges.has(bot.id), fixed);
  const result = { fixed, native_actions: 0, old_accepted_target: B, actual_target: C,
    newer_launch: 'unknown', newer_slot_preserved: true, transport_uncertainty_cleared: !fixed };
  writeFileSync('/tmp/receipt-generation.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { rmSync(root, { recursive: true, force: true }); }
