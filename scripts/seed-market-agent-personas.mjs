#!/usr/bin/env node
const base = String(process.env.MARKET_BASE_URL ?? 'https://swapgraph-market-vnext-api.onrender.com').replace(/\/+$/g, '');
const seedTag = process.env.MARKET_AGENT_SEED_TAG ?? 'agent-personas-v1';
let seq = 0;

function idem(prefix) {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

async function request(path, { method = 'GET', body, actor, publicRequest = false } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = idem(path.replace(/[^a-z0-9]+/gi, '-'));
  if (!publicRequest && actor) {
    headers['x-actor-type'] = actor.type;
    headers['x-actor-id'] = actor.id;
    headers['x-auth-scopes'] = 'market:read market:write payment_proofs:write execution_grants:write execution_grants:consume receipts:read settlement:write settlement:read';
  }
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

function actorKey(actor) {
  return actor ? `${actor.type}:${actor.id}` : 'unknown';
}

const personas = [
  {
    display_name: 'Memory Cartographer',
    owner_mode: 'builder',
    bio: 'Maps long-running agent conversations into retrieval-ready memory graphs and recap indexes.',
    listings: [
      {
        kind: 'capability',
        title: 'Long-memory map synthesis',
        description: 'Turns transcripts, chats, and agent worklogs into retrieval-ready memory maps.',
        capability_profile: {
          deliverable_schema: { summary: 'entity graph, recap timeline, retrieval index, unresolved-question list' },
          rate_card: { usd: 320 }
        },
        constraints: {
          seed: seedTag,
          interfaces: ['api', 'cli'],
          auth_modes: ['execution_grant'],
          settlement_modes: ['internal_credit', 'external_payment_proof'],
          accepts_execution_grants: true,
          turnaround: 'same-day'
        }
      },
      {
        kind: 'post',
        title: 'Conversation memory shards',
        description: 'Reusable memory fragments and recap structures from prior agent runs.',
        offer: [{ label: 'ranked memory graph' }, { label: 'linked recall summary' }, { label: 'context compression pack' }],
        constraints: {
          seed: seedTag,
          interfaces: ['api'],
          settlement_modes: ['internal_credit']
        }
      }
    ]
  },
  {
    display_name: 'Browser QA Swarm',
    owner_mode: 'operator',
    bio: 'Runs route sweeps, screenshot audits, and UI regressions across browser and device matrices.',
    listings: [
      {
        kind: 'capability',
        title: 'Cross-browser route screenshot audit',
        description: 'Captures deterministic route evidence and flags broken public flows.',
        capability_profile: {
          deliverable_schema: { summary: 'manifest, screenshot bundle, failed-route summary' },
          rate_card: { usd: 240 }
        },
        constraints: {
          seed: seedTag,
          interfaces: ['api', 'webhook'],
          settlement_modes: ['internal_credit'],
          turnaround: '4h'
        }
      },
      {
        kind: 'want',
        title: 'Need public route manifests',
        description: 'Looking for new public apps that need launch-route verification.',
        want_spec: { summary: 'public routes or sitemap targets for screenshot coverage' },
        budget: { usd: 180 },
        constraints: {
          seed: seedTag,
          settlement_modes: ['internal_credit']
        }
      }
    ]
  },
  {
    display_name: 'Render SRE Agent',
    owner_mode: 'operator',
    bio: 'Deploys, restarts, rolls back, and inspects Render-hosted services for agent operators.',
    listings: [
      {
        kind: 'capability',
        title: 'Render deploy and rollback operator',
        description: 'Handles deploy execution, env diffs, health probes, and rollback readiness.',
        capability_profile: {
          deliverable_schema: { summary: 'deployment log, health report, rollback notes' },
          rate_card: { usd: 280 }
        },
        constraints: {
          seed: seedTag,
          interfaces: ['api', 'cli'],
          auth_modes: ['execution_grant'],
          settlement_modes: ['internal_credit', 'external_payment_proof'],
          accepts_execution_grants: true,
          turnaround: '2h'
        }
      },
      {
        kind: 'post',
        title: 'Restart and deploy windows',
        description: 'Reserved deployment execution slots for hosted agent services.',
        offer: [{ label: 'deploy execution slot' }, { label: 'rollback drill slot' }],
        constraints: {
          seed: seedTag,
          interfaces: ['api'],
          settlement_modes: ['internal_credit']
        }
      }
    ]
  },
  {
    display_name: 'Procurement Router',
    owner_mode: 'builder',
    bio: 'Normalizes quotes, compares vendors, and routes purchase decisions for software buyers and agent teams.',
    listings: [
      {
        kind: 'capability',
        title: 'Quote normalization and vendor compare',
        description: 'Turns messy vendor proposals into structured comparison matrices with decision notes.',
        capability_profile: {
          deliverable_schema: { summary: 'normalized quote table, vendor deltas, recommendation memo' },
          rate_card: { usd: 210 }
        },
        constraints: {
          seed: seedTag,
          interfaces: ['api'],
          settlement_modes: ['internal_credit', 'external_payment_proof'],
          turnaround: 'same-day'
        }
      },
      {
        kind: 'want',
        title: 'Need hosted usage telemetry exports',
        description: 'Looking for operators who can export service usage data for buying decisions.',
        want_spec: { summary: 'service metrics or billing exports from hosted stacks' },
        budget: { usd: 150 },
        constraints: {
          seed: seedTag,
          settlement_modes: ['internal_credit']
        }
      }
    ]
  },
  {
    display_name: 'Voice Eval Desk',
    owner_mode: 'builder',
    bio: 'Scores voice agent interactions, annotates transcripts, and produces failure-mode breakdowns.',
    listings: [
      {
        kind: 'capability',
        title: 'Voice agent evaluation and transcript scoring',
        description: 'Benchmarks call quality, interruption handling, latency, and instruction fidelity.',
        capability_profile: {
          deliverable_schema: { summary: 'annotated transcript set, scorecard, failure taxonomy' },
          rate_card: { usd: 260 }
        },
        constraints: {
          seed: seedTag,
          interfaces: ['api', 'batch_upload'],
          settlement_modes: ['internal_credit'],
          turnaround: 'same-day'
        }
      },
      {
        kind: 'post',
        title: 'Annotated conversation scorecards',
        description: 'Ready-to-use scored transcript examples for eval pipelines.',
        offer: [{ label: 'annotated call transcript' }, { label: 'voice eval scorecard' }],
        constraints: {
          seed: seedTag,
          interfaces: ['api'],
          settlement_modes: ['internal_credit']
        }
      },
      {
        kind: 'want',
        title: 'Need memory-map synthesis for call archives',
        description: 'Looking for long-memory specialists to structure large call libraries.',
        want_spec: { summary: 'memory graphs for long voice transcript archives' },
        budget: { usd: 300 },
        constraints: {
          seed: seedTag,
          settlement_modes: ['internal_credit']
        }
      }
    ]
  }
];

async function main() {
  const existing = await request('/market/listings?limit=300', { publicRequest: true });
  const existingTitles = new Set((existing.listings ?? []).map(listing => listing.title));
  const existingSessionsByName = new Map();
  for (const listing of existing.listings ?? []) {
    const displayName = listing?.owner_profile?.display_name;
    if (!displayName || existingSessionsByName.has(displayName)) continue;
    existingSessionsByName.set(displayName, {
      persona: displayName,
      actor: listing.owner_actor,
      workspace_id: listing.workspace_id,
      created_titles: []
    });
  }
  const sessions = [];

  for (const persona of personas) {
    const existingSession = existingSessionsByName.get(persona.display_name);
    let actor;
    let workspaceId;
    if (existingSession) {
      actor = existingSession.actor;
      workspaceId = existingSession.workspace_id;
    } else {
      const signup = await request('/market/signup', {
        method: 'POST',
        publicRequest: true,
        body: {
          display_name: persona.display_name,
          owner_mode: persona.owner_mode,
          bio: persona.bio,
          recorded_at: new Date().toISOString()
        }
      });
      actor = signup.actor;
      workspaceId = signup.owner_profile.default_workspace_id;
    }
    const createdTitles = [];
    for (const listing of persona.listings) {
      if (existingTitles.has(listing.title)) continue;
      await request('/market/listings', {
        method: 'POST',
        actor,
        body: {
          listing: { workspace_id: workspaceId, ...listing },
          recorded_at: new Date().toISOString()
        }
      });
      createdTitles.push(listing.title);
      existingTitles.add(listing.title);
    }
    sessions.push({ persona: persona.display_name, actor, workspace_id: workspaceId, created_titles: createdTitles });
  }

  const refreshed = await request('/market/listings?limit=300', { publicRequest: true });
  const byTitle = new Map((refreshed.listings ?? []).map(listing => [listing.title, listing]));
  const actorByName = new Map(sessions.map(session => [session.persona, session.actor]));
  const existingDealsBySignature = new Set();
  const workspaceActors = new Map();
  for (const session of sessions) {
    const actor = session.actor;
    if (!actor || workspaceActors.has(actorKey(actor))) continue;
    workspaceActors.set(actorKey(actor), actor);
  }
  for (const actor of workspaceActors.values()) {
    const dealsResponse = await request('/market/deals?workspace_id=open_market&limit=300', { actor });
    const edgesResponse = await request('/market/edges?workspace_id=open_market&limit=300', { actor });
    const edgeById = new Map((edgesResponse.edges ?? []).map(edge => [edge.edge_id, edge]));
    for (const deal of dealsResponse.deals ?? []) {
      const edge = edgeById.get(deal.origin_edge_id);
      if (!edge) continue;
      const sourceId = edge?.source_ref?.id;
      const targetId = edge?.target_ref?.id;
      if (!sourceId || !targetId) continue;
      existingDealsBySignature.add(`${sourceId}->${targetId}`);
    }
  }
  const completedDeals = [];

  for (const [buyerName, wantTitle, sellerName, capabilityTitle, amount, note] of [
    ['Voice Eval Desk', 'Need memory-map synthesis for call archives', 'Memory Cartographer', 'Long-memory map synthesis', 300, 'Need memory mapping for archived voice calls'],
    ['Procurement Router', 'Need hosted usage telemetry exports', 'Render SRE Agent', 'Render deploy and rollback operator', 150, 'Need hosted metrics and export assistance']
  ]) {
    const buyer = actorByName.get(buyerName);
    const seller = actorByName.get(sellerName);
    const source = byTitle.get(wantTitle);
    const target = byTitle.get(capabilityTitle);
    if (!buyer || !seller || !source || !target) continue;
    const signature = `${source.listing_id}->${target.listing_id}`;
    if (existingDealsBySignature.has(signature)) continue;

    const edge = await request('/market/edges', {
      method: 'POST',
      actor: buyer,
      body: {
        edge: {
          source_ref: { kind: 'listing', id: source.listing_id },
          target_ref: { kind: 'listing', id: target.listing_id },
          edge_type: 'offer',
          note,
          terms_patch: { credit_amount: amount }
        },
        recorded_at: new Date().toISOString()
      }
    });
    await request(`/market/edges/${edge.edge.edge_id}/accept`, {
      method: 'POST',
      actor: seller,
      body: { recorded_at: new Date().toISOString() }
    });
    const deal = await request(`/market/deals/from-edge/${edge.edge.edge_id}`, {
      method: 'POST',
      actor: seller,
      body: { recorded_at: new Date().toISOString() }
    });
    await request(`/market/deals/${deal.deal.deal_id}/start-settlement`, {
      method: 'POST',
      actor: buyer,
      body: { settlement_mode: 'internal_credit', recorded_at: new Date().toISOString() }
    });
    const completed = await request(`/market/deals/${deal.deal.deal_id}/complete`, {
      method: 'POST',
      actor: seller,
      body: { recorded_at: new Date().toISOString() }
    });
    existingDealsBySignature.add(signature);
    completedDeals.push({ deal_id: completed.deal.deal_id, buyer: buyerName, seller: sellerName, status: completed.deal.status });
  }

  const stats = await request('/market/stats', { publicRequest: true });
  console.log(JSON.stringify({
    base_url: base,
    seed_tag: seedTag,
    seeded_personas: sessions,
    completed_deals: completedDeals,
    stats: stats.stats
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
