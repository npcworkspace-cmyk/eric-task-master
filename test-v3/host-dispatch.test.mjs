import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchHost } from '../src/lib/host-dispatch.mjs';
test('host adapter needs an explicit matching receipt from a real process', async () => {
  const adapter = { executable: process.execPath, args: ['--input-type=module', '-e', 'let s="";for await(const c of process.stdin)s+=c;const {event}=JSON.parse(s);process.stdout.write(JSON.stringify({accepted:true,eventId:event.id,deliveryId:"delivery1",received:true}));'] };
  const receipt = await dispatchHost(adapter, { id: 'event1', summary: 'Review' });
  assert.equal(receipt.eventId, 'event1'); assert.equal(receipt.received, true);
  await assert.rejects(dispatchHost({ executable: process.execPath, args: ['-e', 'process.stdout.write("{}")'] }, { id: 'event1' }), { code: 'HOST_RECEIPT_INVALID' });
});
test('host process launch is not a receipt and bounded timeout kills it', async () => {
  await assert.rejects(dispatchHost({ executable: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] }, { id: 'event1' }, { timeoutMs: 50 }), { code: 'HOST_DISPATCH_TIMEOUT' });
});
