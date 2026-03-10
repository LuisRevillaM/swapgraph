#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { positionals, flags };
}

function fail(message, details = null, exitCode = 2) {
  const body = { ok: false, message, details };
  console.error(JSON.stringify(body, null, 2));
  process.exit(exitCode);
}

function parseJsonFlag(value, label) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`invalid JSON for --${label}`, { value, error: String(error?.message ?? error) });
  }
}

function required(value, label) {
  if (value !== undefined && value !== null && String(value).trim()) return value;
  fail(`missing required flag --${label}`);
}

function baseUrl() {
  return String(process.env.SWAPGRAPH_BASE_URL ?? 'http://127.0.0.1:3005').replace(/\/+$/, '');
}

function defaultActor() {
  return {
    type: process.env.SWAPGRAPH_ACTOR_TYPE ?? 'user',
    id: process.env.SWAPGRAPH_ACTOR_ID ?? 'cli_user'
  };
}

function defaultScopes() {
  const raw = process.env.SWAPGRAPH_SCOPES ?? 'market:read market:write payment_proofs:write receipts:read execution_grants:write execution_grants:consume';
  return raw.split(/[,\s]+/g).map(v => v.trim()).filter(Boolean);
}

function nowIso() {
  return process.env.SWAPGRAPH_NOW_ISO ?? new Date().toISOString();
}

function idempotencyKey(suffix = 'op') {
  const prefix = process.env.SWAPGRAPH_IDEMPOTENCY_PREFIX ?? 'market-cli';
  return `${prefix}-${suffix}-${randomUUID()}`;
}

function actorHeaders({ actor, scopes, bearerToken, idempotency }) {
  const headers = {
    'content-type': 'application/json',
    'x-now-iso': nowIso()
  };
  if (idempotency) headers['Idempotency-Key'] = idempotency;
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
    return headers;
  }
  headers['x-actor-type'] = actor.type;
  headers['x-actor-id'] = actor.id;
  headers['x-auth-scopes'] = scopes.join(' ');
  return headers;
}

async function api({ method, path, body, actor = defaultActor(), scopes = defaultScopes(), bearerToken = process.env.SWAPGRAPH_BEARER_TOKEN ?? null, idempotency = null, query = null, allowFailure = false }) {
  const url = new URL(`${baseUrl()}${path}`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: actorHeaders({ actor, scopes, bearerToken, idempotency }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    if (allowFailure) {
      return {
        ok: false,
        status: response.status,
        body: parsed
      };
    }
    fail(`request failed: ${method} ${path}`, { status: response.status, body: parsed }, 1);
  }
  return parsed;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function smokeDirect() {
  const suffix = randomUUID().slice(0, 8);
  const buyer = { type: 'user', id: `buyer_agent_${suffix}` };
  const seller = { type: 'user', id: `seller_agent_${suffix}` };
  const buyerScopes = ['market:read', 'market:write', 'receipts:read'];
  const sellerScopes = ['market:read', 'market:write', 'receipts:read'];

  const post = await api({
    method: 'POST',
    path: '/market/listings',
    actor: seller,
    scopes: sellerScopes,
    idempotency: idempotencyKey('smoke-post'),
    body: {
      listing: {
        workspace_id: 'market_smoke',
        kind: 'post',
        title: 'Seller GPU',
        offer: [{ asset_id: 'gpu_1', class: 'hardware' }]
      },
      recorded_at: nowIso()
    }
  });

  const want = await api({
    method: 'POST',
    path: '/market/listings',
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('smoke-want'),
    body: {
      listing: {
        workspace_id: 'market_smoke',
        kind: 'want',
        title: 'Buyer needs GPU',
        want_spec: { asset_class: 'hardware', asset_id: 'gpu_1' },
        budget: { amount: 25, currency: 'USD' }
      },
      recorded_at: nowIso()
    }
  });

  const edge = await api({
    method: 'POST',
    path: '/market/edges',
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('smoke-edge'),
    body: {
      edge: {
        source_ref: { kind: 'listing', id: want.listing.listing_id },
        target_ref: { kind: 'listing', id: post.listing.listing_id },
        edge_type: 'offer',
        terms_patch: { credit_amount: 25, currency: 'USD' }
      },
      recorded_at: nowIso()
    }
  });

  await api({
    method: 'POST',
    path: `/market/edges/${edge.edge.edge_id}/accept`,
    actor: seller,
    scopes: sellerScopes,
    idempotency: idempotencyKey('smoke-edge-accept'),
    body: { recorded_at: nowIso() }
  });

  const deal = await api({
    method: 'POST',
    path: `/market/deals/from-edge/${edge.edge.edge_id}`,
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('smoke-deal'),
    body: { recorded_at: nowIso() }
  });

  await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/start-settlement`,
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('smoke-start-settlement'),
    body: {
      settlement_mode: 'internal_credit',
      terms: { credit_amount: 25, currency: 'USD' },
      recorded_at: nowIso()
    }
  });

  const completed = await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/complete`,
    actor: seller,
    scopes: sellerScopes,
    idempotency: idempotencyKey('smoke-complete'),
    body: { recorded_at: nowIso() }
  });

  const receipt = await api({
    method: 'GET',
    path: `/market/deals/${deal.deal.deal_id}/receipt`,
    actor: buyer,
    scopes: buyerScopes
  });

  return {
    smoke: 'direct',
    listing_id: post.listing.listing_id,
    want_id: want.listing.listing_id,
    edge_id: edge.edge.edge_id,
    deal_id: deal.deal.deal_id,
    final_status: completed.deal.status,
    receipt_id: receipt.receipt.id
  };
}

async function smokeCapability() {
  const suffix = randomUUID().slice(0, 8);
  const buyer = { type: 'user', id: `buyer_agent_${suffix}` };
  const capabilityProvider = { type: 'user', id: `capability_provider_${suffix}` };
  const capabilityAgent = { type: 'agent', id: `capability_agent_${suffix}` };
  const buyerScopes = ['market:read', 'market:write', 'receipts:read', 'execution_grants:write', 'execution_grants:consume'];
  const capabilityProviderScopes = ['market:read', 'market:write', 'receipts:read', 'delegations:write'];

  const capabilityListing = await api({
    method: 'POST',
    path: '/market/listings',
    actor: capabilityProvider,
    scopes: capabilityProviderScopes,
    idempotency: idempotencyKey('capability-listing'),
    body: {
      listing: {
        workspace_id: 'market_capability',
        kind: 'capability',
        title: 'Summarize data room',
        capability_profile: {
          deliverable_schema: { type: 'object', properties: { summary_uri: { type: 'string' } } },
          rate_card: { currency: 'USD', amount: 15 }
        }
      },
      recorded_at: nowIso()
    }
  });

  const want = await api({
    method: 'POST',
    path: '/market/listings',
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('capability-want'),
    body: {
      listing: {
        workspace_id: 'market_capability',
        kind: 'want',
        title: 'Need diligence summary',
        want_spec: { output: 'summary_uri' },
        budget: { amount: 15, currency: 'USD' }
      },
      recorded_at: nowIso()
    }
  });

  const edge = await api({
    method: 'POST',
    path: '/market/edges',
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('capability-edge'),
    body: {
      edge: {
        source_ref: { kind: 'listing', id: want.listing.listing_id },
        target_ref: { kind: 'listing', id: capabilityListing.listing.listing_id },
        edge_type: 'offer',
        terms_patch: { credit_amount: 15, deliverable: 'summary_uri' }
      },
      recorded_at: nowIso()
    }
  });

  await api({
    method: 'POST',
    path: `/market/edges/${edge.edge.edge_id}/accept`,
    actor: capabilityProvider,
    scopes: capabilityProviderScopes,
    idempotency: idempotencyKey('capability-accept'),
    body: { recorded_at: nowIso() }
  });

  const deal = await api({
    method: 'POST',
    path: `/market/deals/from-edge/${edge.edge.edge_id}`,
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('capability-deal'),
    body: { recorded_at: nowIso() }
  });

  const grant = await api({
    method: 'POST',
    path: '/market/execution-grants',
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('capability-grant'),
    body: {
      grant: {
        deal_id: deal.deal.deal_id,
        audience: capabilityAgent,
        scope: ['execute:deliver'],
        grant_mode: 'encrypted_envelope',
        ciphertext: 'demo-ciphertext'
      },
      recorded_at: nowIso()
    }
  });

  const delegation = await api({
    method: 'POST',
    path: '/delegations',
    actor: capabilityProvider,
    scopes: capabilityProviderScopes,
    idempotency: idempotencyKey('capability-delegation'),
    body: {
      delegation: {
        delegation_id: `delegation-${randomUUID()}`,
        principal_agent: capabilityAgent,
        scopes: ['execution_grants:consume'],
        policy: {
          max_value_per_swap_usd: 100,
          max_value_per_day_usd: 1000,
          min_confidence_score: 0,
          max_cycle_length: 4,
          require_escrow: false,
          quiet_hours: { start: '00:00', end: '00:00', tz: 'UTC' }
        },
        expires_at: new Date(Date.now() + (60 * 60 * 1000)).toISOString()
      }
    }
  });

  await api({
    method: 'POST',
    path: `/market/execution-grants/${grant.grant.grant_id}/consume`,
    bearerToken: delegation.delegation_token,
    idempotency: idempotencyKey('capability-grant-consume'),
    body: { required_scope: 'execute:deliver', recorded_at: nowIso() }
  });

  await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/start-settlement`,
    actor: buyer,
    scopes: buyerScopes,
    idempotency: idempotencyKey('capability-start'),
    body: {
      settlement_mode: 'internal_credit',
      terms: { credit_amount: 15, deliverable_uri: 'memory://summary' },
      recorded_at: nowIso()
    }
  });

  await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/complete`,
    actor: capabilityProvider,
    scopes: capabilityProviderScopes,
    idempotency: idempotencyKey('capability-complete'),
    body: { recorded_at: nowIso() }
  });

  return {
    smoke: 'capability',
    capability_listing_id: capabilityListing.listing.listing_id,
    want_id: want.listing.listing_id,
    deal_id: deal.deal.deal_id,
    grant_id: grant.grant.grant_id
  };
}

async function smokeProof() {
  const suffix = randomUUID().slice(0, 8);
  const buyer = { type: 'user', id: `proof_buyer_${suffix}` };
  const seller = { type: 'user', id: `proof_seller_${suffix}` };
  const scopes = ['market:read', 'market:write', 'payment_proofs:write', 'receipts:read'];

  const post = await api({
    method: 'POST',
    path: '/market/listings',
    actor: seller,
    scopes,
    idempotency: idempotencyKey('proof-post'),
    body: {
      listing: {
        workspace_id: 'market_proof',
        kind: 'post',
        title: 'Seller service',
        offer: [{ service: 'translation' }]
      },
      recorded_at: nowIso()
    }
  });
  const want = await api({
    method: 'POST',
    path: '/market/listings',
    actor: buyer,
    scopes,
    idempotency: idempotencyKey('proof-want'),
    body: {
      listing: {
        workspace_id: 'market_proof',
        kind: 'want',
        title: 'Buyer wants translation'
      },
      recorded_at: nowIso()
    }
  });
  const edge = await api({
    method: 'POST',
    path: '/market/edges',
    actor: buyer,
    scopes,
    idempotency: idempotencyKey('proof-edge'),
    body: {
      edge: {
        source_ref: { kind: 'listing', id: want.listing.listing_id },
        target_ref: { kind: 'listing', id: post.listing.listing_id },
        edge_type: 'offer'
      },
      recorded_at: nowIso()
    }
  });
  await api({
    method: 'POST',
    path: `/market/edges/${edge.edge.edge_id}/accept`,
    actor: seller,
    scopes,
    idempotency: idempotencyKey('proof-accept'),
    body: { recorded_at: nowIso() }
  });
  const deal = await api({
    method: 'POST',
    path: `/market/deals/from-edge/${edge.edge.edge_id}`,
    actor: buyer,
    scopes,
    idempotency: idempotencyKey('proof-deal'),
    body: { recorded_at: nowIso() }
  });
  await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/start-settlement`,
    actor: buyer,
    scopes,
    idempotency: idempotencyKey('proof-start'),
    body: { settlement_mode: 'external_payment_proof', recorded_at: nowIso() }
  });
  const firstAttestation = await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/payment-proof`,
    actor: buyer,
    scopes,
    idempotency: idempotencyKey('proof-attest-1'),
    body: {
      payment_proof: {
        payment_rail: 'bank_transfer',
        proof_fingerprint: `proof-${randomUUID()}`,
        external_reference: 'wire-123',
        attestation_role: 'payer'
      },
      recorded_at: nowIso()
    }
  });

  const firstFailure = await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/complete`,
    actor: seller,
    scopes,
    idempotency: idempotencyKey('proof-complete-fail'),
    body: { recorded_at: nowIso() },
    allowFailure: true
  });
  if (firstFailure.ok !== false) {
    fail('proof smoke expected first completion to fail', firstFailure, 1);
  }

  await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/payment-proof`,
    actor: seller,
    scopes,
    idempotency: idempotencyKey('proof-attest-2'),
    body: {
      payment_proof: {
        payment_rail: firstAttestation.payment_proof.payment_rail,
        proof_fingerprint: firstAttestation.payment_proof.proof_fingerprint,
        external_reference: firstAttestation.payment_proof.external_reference,
        attestation_role: 'payee'
      },
      recorded_at: nowIso()
    }
  });

  const complete = await api({
    method: 'POST',
    path: `/market/deals/${deal.deal.deal_id}/complete`,
    actor: seller,
    scopes,
    idempotency: idempotencyKey('proof-complete'),
    body: { recorded_at: nowIso() }
  });

  return {
    smoke: 'proof',
    deal_id: deal.deal.deal_id,
    payment_proof_id: firstAttestation.payment_proof.proof_id,
    final_status: complete.deal.status,
    first_failure: firstFailure.body?.error?.details?.reason_code ?? 'unknown'
  };
}

async function smokeMultiAgent() {
  const direct = await smokeDirect();
  const capability = await smokeCapability();
  const proof = await smokeProof();
  return { smoke: 'multi-agent', flows: [direct, capability, proof] };
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [group, action] = positionals;
  if (!group) fail('missing command group');

  if (group === 'smoke') {
    const result = await (
      action === 'direct' ? smokeDirect()
        : action === 'capability' ? smokeCapability()
          : action === 'proof' ? smokeProof()
            : action === 'multi-agent' ? smokeMultiAgent()
              : Promise.reject(new Error(`unsupported smoke command: ${action}`))
    );
    print(result);
    return;
  }

  const actor = {
    type: flags['actor-type'] ?? defaultActor().type,
    id: flags['actor-id'] ?? defaultActor().id
  };
  const scopes = flags.scopes ? String(flags.scopes).split(/[,\s]+/g).filter(Boolean) : defaultScopes();
  const bearerToken = flags['bearer-token'] ?? process.env.SWAPGRAPH_BEARER_TOKEN ?? null;

  if (group === 'blueprints') {
    if (action === 'create') {
      const blueprint = parseJsonFlag(flags.body, 'body')?.blueprint ?? {
        workspace_id: required(flags.workspace, 'workspace'),
        title: required(flags.title, 'title'),
        summary: flags.summary,
        category: required(flags.category, 'category'),
        artifact_ref: required(flags['artifact-ref'], 'artifact-ref'),
        artifact_format: required(flags['artifact-format'], 'artifact-format'),
        license_terms: flags['license-terms'],
        support_policy: parseJsonFlag(flags['support-policy-json'], 'support-policy-json'),
        verification_spec: parseJsonFlag(flags['verification-spec-json'], 'verification-spec-json'),
        delivery_mode: required(flags['delivery-mode'], 'delivery-mode'),
        pricing_model: flags['pricing-model'],
        valuation_hint: parseJsonFlag(flags['valuation-hint-json'], 'valuation-hint-json')
      };
      print(await api({ method: 'POST', path: '/market/blueprints', actor, scopes, bearerToken, idempotency: idempotencyKey('blueprints-create'), body: { blueprint, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/blueprints/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/blueprints', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace, status: flags.status, category: flags.category, delivery_mode: flags['delivery-mode'] } }));
      return;
    }
    if (action === 'update') {
      const patch = parseJsonFlag(flags.body, 'body')?.patch ?? {
        title: flags.title,
        summary: flags.summary,
        category: flags.category,
        artifact_ref: flags['artifact-ref'],
        artifact_format: flags['artifact-format'],
        license_terms: flags['license-terms'],
        support_policy: parseJsonFlag(flags['support-policy-json'], 'support-policy-json'),
        verification_spec: parseJsonFlag(flags['verification-spec-json'], 'verification-spec-json'),
        delivery_mode: flags['delivery-mode'],
        pricing_model: flags['pricing-model'],
        valuation_hint: parseJsonFlag(flags['valuation-hint-json'], 'valuation-hint-json')
      };
      Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);
      print(await api({ method: 'PATCH', path: `/market/blueprints/${required(flags.id, 'id')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('blueprints-update'), body: { patch, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'publish' || action === 'archive') {
      print(await api({ method: 'POST', path: `/market/blueprints/${required(flags.id, 'id')}/${action}`, actor, scopes, bearerToken, idempotency: idempotencyKey(`blueprints-${action}`), body: { recorded_at: nowIso() } }));
      return;
    }
  }

  if (group === 'listings') {
    if (action === 'create') {
      const listing = parseJsonFlag(flags.body, 'body')?.listing ?? {
        workspace_id: required(flags.workspace, 'workspace'),
        kind: required(flags.kind, 'kind'),
        title: required(flags.title, 'title'),
        description: flags.description,
        offer: parseJsonFlag(flags['offer-json'], 'offer-json'),
        want_spec: parseJsonFlag(flags['want-spec-json'], 'want-spec-json'),
        budget: parseJsonFlag(flags['budget-json'], 'budget-json'),
        constraints: parseJsonFlag(flags['constraints-json'], 'constraints-json'),
        capability_profile: parseJsonFlag(flags['capability-profile-json'], 'capability-profile-json')
      };
      const response = await api({
        method: 'POST',
        path: '/market/listings',
        actor,
        scopes,
        bearerToken,
        idempotency: idempotencyKey('listings-create'),
        body: { listing, recorded_at: nowIso() }
      });
      print(response);
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/listings/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/listings', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace, kind: flags.kind, status: flags.status } }));
      return;
    }
    if (action === 'update') {
      const patch = parseJsonFlag(flags.body, 'body')?.patch ?? {
        title: flags.title,
        description: flags.description,
        offer: parseJsonFlag(flags['offer-json'], 'offer-json'),
        want_spec: parseJsonFlag(flags['want-spec-json'], 'want-spec-json'),
        budget: parseJsonFlag(flags['budget-json'], 'budget-json'),
        constraints: parseJsonFlag(flags['constraints-json'], 'constraints-json'),
        capability_profile: parseJsonFlag(flags['capability-profile-json'], 'capability-profile-json'),
        expires_at: flags['expires-at']
      };
      Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);
      print(await api({ method: 'PATCH', path: `/market/listings/${required(flags.id, 'id')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('listings-update'), body: { patch, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'close') {
      print(await api({ method: 'POST', path: `/market/listings/${required(flags.id, 'id')}/close`, actor, scopes, bearerToken, idempotency: idempotencyKey('listings-close'), body: { recorded_at: nowIso() } }));
      return;
    }
  }

  if (group === 'edges') {
    if (action === 'create') {
      const body = parseJsonFlag(flags.body, 'body') ?? {
        edge: {
          source_ref: { kind: 'listing', id: required(flags.source, 'source') },
          target_ref: { kind: 'listing', id: required(flags.target, 'target') },
          edge_type: required(flags['edge-type'], 'edge-type'),
          terms_patch: parseJsonFlag(flags['terms-json'], 'terms-json'),
          note: flags.note
        },
        recorded_at: nowIso()
      };
      print(await api({ method: 'POST', path: '/market/edges', actor, scopes, bearerToken, idempotency: idempotencyKey('edges-create'), body }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/edges/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/edges', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace, status: flags.status, edge_type: flags['edge-type'] } }));
      return;
    }
    if (action === 'update') {
      const patch = parseJsonFlag(flags.body, 'body')?.patch ?? {
        terms_patch: parseJsonFlag(flags['terms-json'], 'terms-json'),
        note: flags.note,
        expires_at: flags['expires-at']
      };
      Object.keys(patch).forEach(key => patch[key] === undefined && delete patch[key]);
      print(await api({ method: 'PATCH', path: `/market/edges/${required(flags.id, 'id')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('edges-update'), body: { patch, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'accept' || action === 'decline') {
      print(await api({ method: 'POST', path: `/market/edges/${required(flags.id, 'id')}/${action}`, actor, scopes, bearerToken, idempotency: idempotencyKey(`edges-${action}`), body: { recorded_at: nowIso() } }));
      return;
    }
  }

  if (group === 'candidates') {
    if (action === 'compute') {
      const body = parseJsonFlag(flags.body, 'body') ?? {
        workspace_id: required(flags.workspace, 'workspace'),
        max_cycle_length: flags['max-cycle-length'],
        max_candidates: flags['max-candidates'],
        recorded_at: nowIso()
      };
      Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
      print(await api({ method: 'POST', path: '/market/candidates/compute', actor, scopes, bearerToken, idempotency: idempotencyKey('candidates-compute'), body }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/candidates/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/candidates', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace, status: flags.status, candidate_type: flags['candidate-type'] } }));
      return;
    }
    if (action === 'accept' || action === 'reject' || action === 'refresh') {
      print(await api({ method: 'POST', path: `/market/candidates/${required(flags.id, 'id')}/${action}`, actor, scopes, bearerToken, idempotency: idempotencyKey(`candidates-${action}`), body: { recorded_at: nowIso() } }));
      return;
    }
  }

  if (group === 'threads') {
    if (action === 'create') {
      const participants = parseJsonFlag(flags['participants-json'], 'participants-json');
      const body = parseJsonFlag(flags.body, 'body') ?? {
        thread: {
          workspace_id: required(flags.workspace, 'workspace'),
          participants: participants ?? fail('missing --participants-json'),
          anchor_ref: flags['anchor-kind'] && flags['anchor-id'] ? { kind: flags['anchor-kind'], id: flags['anchor-id'] } : undefined
        },
        recorded_at: nowIso()
      };
      print(await api({ method: 'POST', path: '/market/threads', actor, scopes, bearerToken, idempotency: idempotencyKey('threads-create'), body }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/threads/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/threads', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace } }));
      return;
    }
    if (action === 'message') {
      const payload = flags.text ? { text: flags.text } : parseJsonFlag(flags['payload-json'], 'payload-json');
      print(await api({ method: 'POST', path: `/market/threads/${required(flags.id, 'id')}/messages`, actor, scopes, bearerToken, idempotency: idempotencyKey('threads-message'), body: { message: { message_type: flags['message-type'] ?? (flags.text ? 'text' : 'terms_patch'), payload }, recorded_at: nowIso() } }));
      return;
    }
  }

  if (group === 'deals') {
    if (action === 'from-edge') {
      const body = parseJsonFlag(flags.body, 'body') ?? { deal: parseJsonFlag(flags['deal-json'], 'deal-json'), recorded_at: nowIso() };
      print(await api({ method: 'POST', path: `/market/deals/from-edge/${required(flags.edge, 'edge')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('deals-create'), body }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/deals/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'start-settlement') {
      print(await api({ method: 'POST', path: `/market/deals/${required(flags.id, 'id')}/start-settlement`, actor, scopes, bearerToken, idempotency: idempotencyKey('deals-start'), body: parseJsonFlag(flags.body, 'body') ?? { settlement_mode: required(flags['settlement-mode'], 'settlement-mode'), terms: parseJsonFlag(flags['terms-json'], 'terms-json'), cycle_id: flags['cycle-id'], recorded_at: nowIso() } }));
      return;
    }
    if (action === 'payment-proof') {
      print(await api({ method: 'POST', path: `/market/deals/${required(flags.id, 'id')}/payment-proof`, actor, scopes, bearerToken, idempotency: idempotencyKey('deals-proof'), body: parseJsonFlag(flags.body, 'body') ?? { payment_proof: { payment_rail: required(flags['payment-rail'], 'payment-rail'), proof_fingerprint: required(flags['proof-fingerprint'], 'proof-fingerprint'), external_reference: flags['external-reference'], attestation_role: required(flags['attestation-role'], 'attestation-role') }, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'complete') {
      print(await api({ method: 'POST', path: `/market/deals/${required(flags.id, 'id')}/complete`, actor, scopes, bearerToken, idempotency: idempotencyKey('deals-complete'), body: { recorded_at: nowIso() } }));
      return;
    }
    if (action === 'receipt') {
      print(await api({ method: 'GET', path: `/market/deals/${required(flags.id, 'id')}/receipt`, actor, scopes, bearerToken }));
      return;
    }
  }

  if (group === 'plans') {
    if (action === 'create-from-candidate') {
      const body = parseJsonFlag(flags.body, 'body') ?? { plan: parseJsonFlag(flags['plan-json'], 'plan-json'), recorded_at: nowIso() };
      print(await api({ method: 'POST', path: `/market/execution-plans/from-candidate/${required(flags.candidate, 'candidate')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('plans-create'), body }));
      return;
    }
    if (action === 'get') {
      print(await api({ method: 'GET', path: `/market/execution-plans/${required(flags.id, 'id')}`, actor, scopes, bearerToken }));
      return;
    }
    if (action === 'list') {
      print(await api({ method: 'GET', path: '/market/execution-plans', actor, scopes, bearerToken, query: parseJsonFlag(flags.query, 'query') ?? { workspace_id: flags.workspace, status: flags.status, plan_type: flags['plan-type'] } }));
      return;
    }
    if (action === 'accept' || action === 'decline') {
      print(await api({ method: 'POST', path: `/market/execution-plans/${required(flags.id, 'id')}/${action}`, actor, scopes, bearerToken, idempotency: idempotencyKey(`plans-${action}`), body: { recorded_at: nowIso() } }));
      return;
    }
    if (action === 'start-settlement') {
      const body = parseJsonFlag(flags.body, 'body') ?? { settlement_mode: flags['settlement-mode'], terms: parseJsonFlag(flags['terms-json'], 'terms-json'), cycle_id: flags['cycle-id'], recorded_at: nowIso() };
      Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
      print(await api({ method: 'POST', path: `/market/execution-plans/${required(flags.id, 'id')}/start-settlement`, actor, scopes, bearerToken, idempotency: idempotencyKey('plans-start'), body }));
      return;
    }
    if (action === 'complete-leg') {
      const body = parseJsonFlag(flags.body, 'body') ?? { verification_result: parseJsonFlag(flags['verification-json'], 'verification-json'), recorded_at: nowIso() };
      Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
      print(await api({ method: 'POST', path: `/market/execution-plans/${required(flags.id, 'id')}/complete-leg/${required(flags.leg, 'leg')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('plans-complete-leg'), body }));
      return;
    }
    if (action === 'fail-leg') {
      const body = parseJsonFlag(flags.body, 'body') ?? { failure_reason: flags['failure-reason'], recorded_at: nowIso() };
      Object.keys(body).forEach(key => body[key] === undefined && delete body[key]);
      print(await api({ method: 'POST', path: `/market/execution-plans/${required(flags.id, 'id')}/fail-leg/${required(flags.leg, 'leg')}`, actor, scopes, bearerToken, idempotency: idempotencyKey('plans-fail-leg'), body }));
      return;
    }
    if (action === 'receipt') {
      print(await api({ method: 'GET', path: `/market/execution-plans/${required(flags.id, 'id')}/receipt`, actor, scopes, bearerToken }));
      return;
    }
  }

  if (group === 'grants') {
    if (action === 'create') {
      print(await api({ method: 'POST', path: '/market/execution-grants', actor, scopes, bearerToken, idempotency: idempotencyKey('grants-create'), body: parseJsonFlag(flags.body, 'body') ?? { grant: { deal_id: flags.deal, audience: { type: required(flags['audience-type'], 'audience-type'), id: required(flags['audience-id'], 'audience-id') }, scope: String(required(flags.scope, 'scope')).split(',').map(v => v.trim()).filter(Boolean), grant_mode: required(flags['grant-mode'], 'grant-mode'), ciphertext: flags.ciphertext }, recorded_at: nowIso() } }));
      return;
    }
    if (action === 'consume') {
      print(await api({ method: 'POST', path: `/market/execution-grants/${required(flags.id, 'id')}/consume`, actor, scopes, bearerToken, idempotency: idempotencyKey('grants-consume'), body: { required_scope: flags['required-scope'], recorded_at: nowIso() } }));
      return;
    }
  }

  fail(`unsupported command: ${group} ${action ?? ''}`.trim());
}

main().catch(error => {
  fail('market-cli failed', { error: String(error?.message ?? error), stack: error?.stack ?? null }, 1);
});
