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
    assert.match(html, /\/demo\/live-board\/docs/);
    assert.match(html, /Start New Agent Cycle/);
    assert.match(html, /Live Feeds/);
    assert.match(html, /Visualization/);

    const docsResponse = await fetch(`${runtime.baseUrl}/demo/live-board/docs`, {
      headers: { accept: 'text/html' }
    });
    assert.equal(docsResponse.status, 200);
    assert.match(docsResponse.headers.get('content-type') ?? '', /text\/html/i);
    const docsHtml = await docsResponse.text();
    assert.match(docsHtml, /Demo Docs/);
    assert.match(docsHtml, /Live System Health/);
    assert.match(docsHtml, /How The Demo Works/);

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
  const workspaceActors = new Set(['workshop', 'architects_dream', 'cto', 'toxins', 'graph_board', 'marketplace']);

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
      path: '/demo/live-board/snapshot?limit=20&lanes=workshop,architects_dream,cto,toxins,graph_board,marketplace&workspace_only=1'
    });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.body?.ok, true);
    assert.equal(snapshotResponse.body?.snapshot?.workspace_only, true);
    assert.ok((snapshotResponse.body?.snapshot?.funnel?.receipts_completed ?? 0) >= 1);
    assert.ok((snapshotResponse.body?.snapshot?.funnel?.commits_total ?? 0) >= 1);
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.posts));
    assert.ok(snapshotResponse.body.snapshot.posts.length >= 4);
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => typeof post.image_url === 'string' && post.image_url.length > 0));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'workshop'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'architects_dream'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'cto'));
    assert.ok(snapshotResponse.body.snapshot.posts.some(post => post.actor_id === 'toxins'));
    assert.ok(snapshotResponse.body.snapshot.posts.every(post => workspaceActors.has(post.actor_id)));
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.trade_cycles));
    assert.ok(snapshotResponse.body.snapshot.trade_cycles.length >= 1);
    const cycle = snapshotResponse.body.snapshot.trade_cycles[0];
    assert.equal(typeof cycle?.cycle_id, 'string');
    assert.ok(Array.isArray(cycle?.participants));
    assert.ok(cycle.participants.length >= 2);
    assert.ok(cycle.participants.every(row => workspaceActors.has(row?.actor_id)));
    assert.ok(cycle.participants.some(row => typeof row?.gives?.image_url === 'string' && row.gives.image_url.length > 0));
    assert.ok(cycle.participants.some(row => typeof row?.gets?.image_url === 'string' && row.gets.image_url.length > 0));
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.cycles));
    assert.ok(snapshotResponse.body.snapshot.cycles.every(row =>
      Array.isArray(row?.participants) && row.participants.every(participant => workspaceActors.has(participant?.id))
    ));
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.events));
    assert.ok(snapshotResponse.body.snapshot.events.every(row => row.actor_id === null || workspaceActors.has(row.actor_id)));
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.matching_runs));
    assert.ok(snapshotResponse.body.snapshot.matching_runs.every(row => workspaceActors.has(row?.requested_by?.id)));
  } finally {
    await runtime.close();
  }
});

test('demo live board trigger supports multihop mode with 4-actor cycle', async () => {
  const runtime = await startRuntimeHarness();

  try {
    const triggerResponse = await fetch(`${runtime.baseUrl}/demo/live-board/trigger-cycle`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ mode: 'multihop' })
    });
    assert.equal(triggerResponse.status, 200);
    const triggerBody = await triggerResponse.json();
    assert.equal(triggerBody?.ok, true);
    assert.equal(triggerBody?.demo_cycle?.mode, 'multihop');
    assert.ok(Array.isArray(triggerBody?.demo_cycle?.settled_cycles));
    assert.ok(triggerBody.demo_cycle.settled_cycles.length >= 1);
    assert.ok(triggerBody.demo_cycle.settled_cycles.some(row => (row?.participant_actor_ids?.length ?? 0) >= 4));
    assert.ok(triggerBody.demo_cycle.settled_cycles.every(row => row.final_state === 'completed'));
  } finally {
    await runtime.close();
  }
});

test('demo live board can trigger post and match waves for cadence mode', async () => {
  const runtime = await startRuntimeHarness();

  try {
    const postWaveResponse = await fetch(`${runtime.baseUrl}/demo/live-board/trigger-wave`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ phase: 'post', mode: 'balanced' })
    });
    assert.equal(postWaveResponse.status, 200);
    const postWaveBody = await postWaveResponse.json();
    assert.equal(postWaveBody?.ok, true);
    assert.equal(postWaveBody?.demo_wave?.scenario, 'four_workspace_post_wave');
    assert.equal(postWaveBody?.demo_wave?.phase, 'post');
    assert.ok(Array.isArray(postWaveBody?.demo_wave?.created_intents));
    assert.ok(postWaveBody.demo_wave.created_intents.length >= 4);
    assert.equal(postWaveBody?.demo_wave?.proposal_count, 0);
    assert.equal(postWaveBody?.demo_wave?.cycle_count, 0);

    const matchWaveResponse = await fetch(`${runtime.baseUrl}/demo/live-board/trigger-wave`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ phase: 'match', mode: 'multihop' })
    });
    assert.equal(matchWaveResponse.status, 200);
    const matchWaveBody = await matchWaveResponse.json();
    assert.equal(matchWaveBody?.ok, true);
    assert.equal(matchWaveBody?.demo_wave?.scenario, 'four_workspace_post_wave');
    assert.equal(matchWaveBody?.demo_wave?.phase, 'match');
    assert.ok(Array.isArray(matchWaveBody?.demo_wave?.created_intents));
    assert.ok(matchWaveBody.demo_wave.created_intents.length >= 4);
    assert.ok(Number.isFinite(matchWaveBody?.demo_wave?.proposal_count));
    assert.ok(Array.isArray(matchWaveBody?.demo_wave?.proposed_cycles));
    assert.ok(matchWaveBody?.demo_wave?.cycle_count === 0);

    const snapshotResponse = await requestJson({
      baseUrl: runtime.baseUrl,
      method: 'GET',
      path: '/demo/live-board/snapshot?limit=50&workspace_only=1'
    });
    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshotResponse.body?.ok, true);
    assert.ok(Array.isArray(snapshotResponse.body?.snapshot?.events));
    assert.ok(snapshotResponse.body.snapshot.events.some(row => row.type === 'intent.posted'));
  } finally {
    await runtime.close();
  }
});
