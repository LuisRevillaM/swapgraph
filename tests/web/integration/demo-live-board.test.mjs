import test from 'node:test';
import assert from 'node:assert/strict';

import { requestJson, seedMatchingScenario, settleProposalToReceipt, startRuntimeHarness } from '../../../scripts/web-m1/runtimeHarness.mjs';

test('demo live board serves html and snapshot without actor auth', async () => {
  const runtime = await startRuntimeHarness();

  try {
    const seeded = await seedMatchingScenario({ baseUrl: runtime.baseUrl });
    await settleProposalToReceipt({
      baseUrl: runtime.baseUrl,
      proposalId: seeded.proposalId,
      actorA: seeded.actorA,
      actorB: seeded.actorB,
      partner: seeded.partner
    });

    const htmlResponse = await fetch(`${runtime.baseUrl}/demo/live-board`, {
      headers: { accept: 'text/html' }
    });
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type') ?? '', /text\/html/i);
    const html = await htmlResponse.text();
    assert.match(html, /SwapGraph Live Board/);

    const snapshotResponse = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/demo/live-board/snapshot?limit=5&lanes=workshop,architects_dream'
    });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.body?.ok, true);
    assert.equal(typeof snapshotResponse.body?.snapshot?.generated_at, 'string');
    assert.equal(snapshotResponse.body?.snapshot?.limit, 5);
    assert.ok((snapshotResponse.body?.snapshot?.funnel?.intents_total ?? 0) >= 2);
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.events));
    assert.ok(snapshotResponse.body.snapshot.events.length <= 5);
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.lanes));
    assert.equal(snapshotResponse.body.snapshot.lanes.length, 2);
  } finally {
    await runtime.close();
  }
});
