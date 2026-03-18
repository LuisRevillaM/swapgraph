import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeApiServer } from '../../src/server/runtimeApiServer.mjs';

function idem(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function api(baseUrl, route, { method = 'GET', token = null, body = undefined, idempotencyKey = null } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { response, json, text };
}

async function createSession(baseUrl, { email, displayName }) {
  const started = await api(baseUrl, '/market/auth/start', {
    method: 'POST',
    idempotencyKey: idem('authstart'),
    body: {
      email,
      display_name: displayName,
      owner_mode: 'agent_owner',
      workspace_id: 'open_market',
      recorded_at: '2026-03-18T15:00:00.000Z'
    }
  });
  assert.equal(started.response.status, 200, started.text);
  const verified = await api(baseUrl, '/market/auth/verify', {
    method: 'POST',
    idempotencyKey: idem('authverify'),
    body: {
      challenge_id: started.json.challenge_id,
      verification_code: started.json.verification_code,
      recorded_at: '2026-03-18T15:01:00.000Z'
    }
  });
  assert.equal(verified.response.status, 200, verified.text);
  return {
    actor: verified.json.actor,
    token: verified.json.session.session_token,
    session: verified.json.session
  };
}

async function createListing(baseUrl, token, listing) {
  const created = await api(baseUrl, '/market/listings', {
    method: 'POST',
    token,
    idempotencyKey: idem('listing'),
    body: { listing, recorded_at: '2026-03-18T15:02:00.000Z' }
  });
  assert.equal(created.response.status, 200, created.text);
  return created.json.listing;
}

async function createEdge(baseUrl, token, edge) {
  const created = await api(baseUrl, '/market/edges', {
    method: 'POST',
    token,
    idempotencyKey: idem('edge'),
    body: { edge, recorded_at: '2026-03-18T15:05:00.000Z' }
  });
  assert.equal(created.response.status, 200, created.text);
  return created.json.edge;
}

async function createBlueprint(baseUrl, token) {
  const created = await api(baseUrl, '/market/blueprints', {
    method: 'POST',
    token,
    idempotencyKey: idem('blueprint'),
    body: {
      blueprint: {
        workspace_id: 'open_market',
        title: 'Incident triage checklist',
        summary: 'Repeatable incident-first response workflow.',
        category: 'workflow',
        artifact_ref: 'repo://swapgraph/examples/incident-triage',
        artifact_format: 'markdown_bundle',
        delivery_mode: 'download',
        pricing_model: 'barter_only',
        status: 'draft'
      },
      recorded_at: '2026-03-18T15:03:00.000Z'
    }
  });
  assert.equal(created.response.status, 200, created.text);
  const blueprintId = created.json.blueprint.blueprint_id;
  const published = await api(baseUrl, `/market/blueprints/${encodeURIComponent(blueprintId)}/publish`, {
    method: 'POST',
    token,
    idempotencyKey: idem('blueprintpublish'),
    body: { recorded_at: '2026-03-18T15:04:00.000Z' }
  });
  assert.equal(published.response.status, 200, published.text);
  return published.json.blueprint;
}

test('runtime serves scoped OpenAPI and documented routes resolve through live handlers', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swapgraph-openapi-'));
  const storePath = path.join(tmpDir, 'state.json');
  const envBackup = {
    AUTHZ_ENFORCE: process.env.AUTHZ_ENFORCE,
    MARKET_OPEN_SIGNUP_MODE: process.env.MARKET_OPEN_SIGNUP_MODE
  };
  process.env.AUTHZ_ENFORCE = '1';
  process.env.MARKET_OPEN_SIGNUP_MODE = 'open';

  const runtime = createRuntimeApiServer({
    host: '127.0.0.1',
    port: 0,
    stateBackend: 'json',
    storePath
  });

  try {
    await runtime.listen();
    const baseUrl = `http://${runtime.host}:${runtime.port}`;

    const userA = await createSession(baseUrl, { email: 'qa-bot@swapgraph.test', displayName: 'QA Bot' });
    const userB = await createSession(baseUrl, { email: 'release-bot@swapgraph.test', displayName: 'Release Bot' });
    const userC = await createSession(baseUrl, { email: 'ops-bot@swapgraph.test', displayName: 'Ops Bot' });

    const listingA = await createListing(baseUrl, userA.token, {
      workspace_id: 'open_market',
      kind: 'post',
      title: 'Structured QA pass',
      description: 'QA pass with reproducible notes.',
      offer: [{ label: 'qa_pass' }]
    });
    const listingB = await createListing(baseUrl, userB.token, {
      workspace_id: 'open_market',
      kind: 'want',
      title: 'Need deployment review',
      description: 'Review Render deploy steps and rollback notes.',
      offer: [],
      want_spec: { desired_labels: ['deployment_review'] },
      budget: { amount_usd: 25 }
    });

    const blueprint = await createBlueprint(baseUrl, userA.token);

    const edge = await createEdge(baseUrl, userA.token, {
      source_ref: { kind: 'listing', id: listingA.listing_id },
      target_ref: { kind: 'listing', id: listingB.listing_id },
      edge_type: 'offer',
      note: 'Can swap QA for review, deploy help, or a balancing cash leg.',
      terms_patch: { amount_usd: 25 }
    });

    const acceptedEdge = await api(baseUrl, `/market/edges/${encodeURIComponent(edge.edge_id)}/accept`, {
      method: 'POST',
      token: userB.token,
      idempotencyKey: idem('edgeaccept'),
      body: { recorded_at: '2026-03-18T15:06:00.000Z' }
    });
    assert.equal(acceptedEdge.response.status, 200, acceptedEdge.text);

    await createListing(baseUrl, userA.token, {
      listing_id: 'cycle_post_a',
      workspace_id: 'cycle_market',
      kind: 'post',
      title: 'Asset A',
      offer: [{ platform: 'steam', asset_id: 'assetA', metadata: { category: 'games' }, estimated_value_usd: 10 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetB' }] },
      valuation_hint: { usd_total: 10 }
    });
    await createListing(baseUrl, userB.token, {
      listing_id: 'cycle_post_b',
      workspace_id: 'cycle_market',
      kind: 'post',
      title: 'Asset B',
      offer: [{ platform: 'steam', asset_id: 'assetB', metadata: { category: 'games' }, estimated_value_usd: 11 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetC' }] },
      valuation_hint: { usd_total: 11 }
    });
    await createListing(baseUrl, userC.token, {
      listing_id: 'cycle_post_c',
      workspace_id: 'cycle_market',
      kind: 'post',
      title: 'Asset C',
      offer: [{ platform: 'steam', asset_id: 'assetC', metadata: { category: 'games' }, estimated_value_usd: 12 }],
      want_spec: { type: 'set', any_of: [{ type: 'specific_asset', platform: 'steam', asset_key: 'steam:assetA' }] },
      valuation_hint: { usd_total: 12 }
    });

    const computed = await api(baseUrl, '/market/candidates/compute', {
      method: 'POST',
      token: userA.token,
      idempotencyKey: idem('candidatecompute'),
      body: {
        workspace_id: 'cycle_market',
        max_cycle_length: 4,
        max_candidates: 10,
        recorded_at: '2026-03-18T15:07:00.000Z'
      }
    });
    assert.equal(computed.response.status, 200, computed.text);
    const candidate = (computed.json.candidates ?? []).find((row) => row.candidate_type === 'cycle');
    assert.ok(candidate, 'expected one cycle candidate');

    const createdDeal = await api(baseUrl, `/market/deals/from-edge/${encodeURIComponent(edge.edge_id)}`, {
      method: 'POST',
      token: userA.token,
      idempotencyKey: idem('dealcreate'),
      body: {
        deal: { terms: { amount_usd: 25 } },
        recorded_at: '2026-03-18T15:08:00.000Z'
      }
    });
    assert.equal(createdDeal.response.status, 200, createdDeal.text);
    const deal = createdDeal.json.deal;

    const settlement = await api(baseUrl, `/market/deals/${encodeURIComponent(deal.deal_id)}/start-settlement`, {
      method: 'POST',
      token: userA.token,
      idempotencyKey: idem('dealsettlement'),
      body: {
        settlement_mode: 'internal_credit',
        terms: { amount_usd: 25 },
        recorded_at: '2026-03-18T15:09:00.000Z'
      }
    });
    assert.equal(settlement.response.status, 200, settlement.text);

    const completed = await api(baseUrl, `/market/deals/${encodeURIComponent(deal.deal_id)}/complete`, {
      method: 'POST',
      token: userA.token,
      idempotencyKey: idem('dealcomplete'),
      body: { recorded_at: '2026-03-18T15:10:00.000Z' }
    });
    assert.equal(completed.response.status, 200, completed.text);

    const discovery = await api(baseUrl, '/.well-known/swapgraph');
    assert.equal(discovery.response.status, 200, discovery.text);
    assert.equal(discovery.json.links.openapi, `${baseUrl}/openapi.json`);

    const openapi = await api(baseUrl, '/openapi.json');
    assert.equal(openapi.response.status, 200, openapi.text);
    assert.equal(openapi.json.openapi, '3.0.3');
    const pathEntries = Object.entries(openapi.json.paths ?? {});
    assert.ok(pathEntries.length >= 20, `expected at least 20 paths, got ${pathEntries.length}`);

    const ids = {
      listing_id: listingA.listing_id,
      edge_id: edge.edge_id,
      candidate_id: candidate.candidate_id,
      deal_id: deal.deal_id,
      plan_id: 'plan_probe',
      leg_id: 'leg_probe',
      blueprint_id: blueprint.blueprint_id,
      thread_id: 'thread_probe',
      moderation_id: 'moderation_probe',
      slug: 'agent-quickstart'
    };

    const specialBodies = {
      'POST /.well-known/swapgraph': null,
      'POST /market/signup': {
        display_name: 'Probe Signup',
        owner_mode: 'agent_owner',
        workspace_id: 'open_market',
        recorded_at: '2026-03-18T15:11:00.000Z'
      },
      'POST /market/auth/start': {
        email: 'probe-auth@swapgraph.test',
        display_name: 'Probe Auth',
        owner_mode: 'agent_owner',
        workspace_id: 'open_market',
        recorded_at: '2026-03-18T15:12:00.000Z'
      }
    };

    for (const [specPath, operations] of pathEntries) {
      for (const [method, operation] of Object.entries(operations)) {
        const actualPath = specPath.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(ids[key] ?? `${key}_probe`));
        const routeKey = `${method.toUpperCase()} ${specPath}`;
        let token = null;
        let body = undefined;
        let idempotencyKey = null;

        if (routeKey === 'POST /market/auth/verify') {
          const started = await api(baseUrl, '/market/auth/start', {
            method: 'POST',
            idempotencyKey: idem('authstartprobe'),
            body: {
              email: 'verify-probe@swapgraph.test',
              display_name: 'Verify Probe',
              owner_mode: 'agent_owner',
              workspace_id: 'open_market',
              recorded_at: '2026-03-18T15:13:00.000Z'
            }
          });
          assert.equal(started.response.status, 200, started.text);
          body = {
            challenge_id: started.json.challenge_id,
            verification_code: started.json.verification_code,
            recorded_at: '2026-03-18T15:14:00.000Z'
          };
          idempotencyKey = idem('authverifyprobe');
        } else if (routeKey in specialBodies) {
          body = specialBodies[routeKey];
          idempotencyKey = idem('probe');
        } else if (operation.security) {
          token = null;
        }

        if (['post', 'patch'].includes(method) && idempotencyKey === null && routeKey !== 'POST /.well-known/swapgraph') {
          idempotencyKey = idem('probe');
        }

        const result = await api(baseUrl, actualPath, {
          method: method.toUpperCase(),
          token,
          body,
          idempotencyKey
        });

        assert.notEqual(result.response.status, 404, `${routeKey} resolved to 404 at ${actualPath}`);

        if (!operation.security && method === 'get') {
          assert.equal(result.response.status, 200, `${routeKey} expected 200, got ${result.response.status}: ${result.text}`);
        } else if (operation.security) {
          assert.ok([200, 401].includes(result.response.status), `${routeKey} expected 200 or 401, got ${result.response.status}: ${result.text}`);
        } else {
          assert.ok([200, 400].includes(result.response.status), `${routeKey} expected 200 or 400, got ${result.response.status}: ${result.text}`);
        }
      }
    }
  } finally {
    await runtime.close();
    if (envBackup.AUTHZ_ENFORCE === undefined) delete process.env.AUTHZ_ENFORCE; else process.env.AUTHZ_ENFORCE = envBackup.AUTHZ_ENFORCE;
    if (envBackup.MARKET_OPEN_SIGNUP_MODE === undefined) delete process.env.MARKET_OPEN_SIGNUP_MODE; else process.env.MARKET_OPEN_SIGNUP_MODE = envBackup.MARKET_OPEN_SIGNUP_MODE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
