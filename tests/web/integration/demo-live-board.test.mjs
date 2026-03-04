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
    assert.match(html, /Start New Agent Cycle/);
    assert.match(html, /Trade Cycles/);

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
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.trade_cycles));
    assert.ok(snapshotResponse.body.snapshot.trade_cycles.length >= 1);
  } finally {
    await runtime.close();
  }
});

test('demo live board can trigger new four-workspace cycles from UI endpoint', async () => {
  const runtime = await startRuntimeHarness();

  try {
    const triggerResponse = await fetch(`${runtime.baseUrl}/demo/live-board/trigger-cycle`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({})
    });
    assert.equal(triggerResponse.status, 200);
    const triggerBody = await triggerResponse.json();
    assert.equal(triggerBody?.ok, true);
    assert.equal(triggerBody?.demo_cycle?.scenario, 'four_workspace_demo_cycle');
    assert.ok(Array.isArray(triggerBody?.demo_cycle?.actors));
    assert.ok(triggerBody.demo_cycle.actors.includes('workshop'));
    assert.ok(triggerBody.demo_cycle.actors.includes('architects_dream'));
    assert.ok(triggerBody.demo_cycle.actors.includes('cto'));
    assert.ok(triggerBody.demo_cycle.actors.includes('toxins'));
    assert.ok(Array.isArray(triggerBody?.demo_cycle?.settled_cycles));
    assert.ok(triggerBody.demo_cycle.settled_cycles.length >= 1);
    assert.ok(triggerBody.demo_cycle.settled_cycles.every(row => row.final_state === 'completed'));

    const snapshotResponse = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/demo/live-board/snapshot?limit=10&lanes=workshop,architects_dream,cto,toxins,marketplace'
    });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.body?.ok, true);
    assert.ok((snapshotResponse.body?.snapshot?.funnel?.receipts_completed ?? 0) >= 1);
    assert.ok((snapshotResponse.body?.snapshot?.funnel?.commits_total ?? 0) >= 1);
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.posts));
    assert.ok(snapshotResponse.body.snapshot.posts.length >= 4);
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => typeof post.image_url === 'string' && post.image_url.length > 0));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'workshop'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'architects_dream'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'cto'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'toxins'));
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.trade_cycles));
    assert.ok(snapshotResponse.body.snapshot.trade_cycles.length >= 1);
    const cycle = snapshotResponse.body.snapshot.trade_cycles[0];
    assert.equal(typeof cycle?.cycle_id, 'string');
    assert.ok(Array.isArray(cycle?.participants));
    assert.ok(cycle.participants.length >= 2);
    assert.ok(cycle.participants.some(row => typeof row?.gives?.image_url === 'string' && row.gives.image_url.length > 0));
    assert.ok(cycle.participants.some(row => typeof row?.gets?.image_url === 'string' && row.gets.image_url.length > 0));
  } finally {
    await runtime.close();
  }
});
