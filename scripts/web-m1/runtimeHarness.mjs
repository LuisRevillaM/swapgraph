import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { createRuntimeApiServer } from '../../src/server/runtimeApiServer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');

function headersForActor({ actorType, actorId, scopes = [] }) {
  return {
    'x-actor-type': actorType,
    'x-actor-id': actorId,
    ...(scopes.length > 0 ? { 'x-auth-scopes': scopes.join(' ') } : {})
  };
}

export function token(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function startRuntimeHarness() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'swapgraph-web-m1-'));
  const stateFile = path.join(tempDir, 'state.json');

  const runtime = createRuntimeApiServer({
    host: '127.0.0.1',
    port: 0,
    stateBackend: 'json',
    storePath: stateFile
  });

  await runtime.listen();

  return {
    baseUrl: `http://${runtime.host}:${runtime.port}`,
    stateFile,
    tempDir,
    async close() {
      await runtime.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  };
}

export async function requestJson({
  baseUrl,
  method = 'GET',
  path: routePath,
  actor,
  scopes = [],
  idempotencyKey = null,
  body
}) {
  const headers = {
    accept: 'application/json'
  };

  if (actor) {
    Object.assign(headers, headersForActor({
      actorType: actor.type,
      actorId: actor.id,
      scopes
    }));
  }

  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const response = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  return {
    status: response.status,
    headers: {
      correlationId: response.headers.get('x-correlation-id')
    },
    body: parsed
  };
}

export function buildIntentPayload({ intentId, actorId, offerAssetId, wantAssetId, valueUsd }) {
  return {
    intent: {
      id: intentId,
      actor: {
        type: 'user',
        id: actorId
      },
      offer: [
        {
          platform: 'steam',
          app_id: 730,
          context_id: 2,
          asset_id: offerAssetId,
          class_id: `cls_${offerAssetId}`,
          instance_id: '0',
          metadata: {
            value_usd: valueUsd
          },
          proof: {
            inventory_snapshot_id: `snap_${offerAssetId}`,
            verified_at: new Date().toISOString()
          }
        }
      ],
      want_spec: {
        type: 'set',
        any_of: [
          {
            type: 'specific_asset',
            platform: 'steam',
            asset_key: `steam:${wantAssetId}`
          }
        ]
      },
      value_band: {
        min_usd: Math.max(1, valueUsd - 20),
        max_usd: valueUsd + 20,
        pricing_source: 'market_median'
      },
      trust_constraints: {
        max_cycle_length: 3,
        min_counterparty_reliability: 0
      },
      time_constraints: {
        expires_at: '2027-12-31T00:00:00.000Z',
        urgency: 'normal'
      },
      settlement_preferences: {
        require_escrow: true
      }
    }
  };
}

export async function seedMatchingScenario({ baseUrl }) {
  const actorA = { type: 'user', id: token('user_a') };
  const actorB = { type: 'user', id: token('user_b') };
  const partner = { type: 'partner', id: 'marketplace' };

  const assetA = token('asset_a');
  const assetB = token('asset_b');

  const intentA = buildIntentPayload({
    intentId: token('intent_a'),
    actorId: actorA.id,
    offerAssetId: assetA,
    wantAssetId: assetB,
    valueUsd: 100
  });

  const intentB = buildIntentPayload({
    intentId: token('intent_b'),
    actorId: actorB.id,
    offerAssetId: assetB,
    wantAssetId: assetA,
    valueUsd: 101
  });

  const createA = await requestJson({
    baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor: actorA,
    scopes: ['swap_intents:write'],
    idempotencyKey: token('create_a'),
    body: intentA
  });
  if (createA.status !== 200) throw new Error(`seed intent A failed: ${JSON.stringify(createA.body)}`);

  const createB = await requestJson({
    baseUrl,
    method: 'POST',
    path: '/swap-intents',
    actor: actorB,
    scopes: ['swap_intents:write'],
    idempotencyKey: token('create_b'),
    body: intentB
  });
  if (createB.status !== 200) throw new Error(`seed intent B failed: ${JSON.stringify(createB.body)}`);

  const run = await requestJson({
    baseUrl,
    method: 'POST',
    path: '/marketplace/matching/runs',
    actor: partner,
    scopes: ['settlement:write'],
    idempotencyKey: token('run'),
    body: {
      replace_existing: true,
      max_proposals: 20
    }
  });

  if (run.status !== 200) throw new Error(`matching run failed: ${JSON.stringify(run.body)}`);

  const proposalId = run.body?.run?.proposal_ids?.[0] ?? null;
  if (!proposalId) throw new Error('matching run produced no proposals');

  return {
    actorA,
    actorB,
    partner,
    proposalId,
    runId: run.body?.run?.run_id ?? null
  };
}

export async function settleProposalToReceipt({ baseUrl, proposalId, actorA, actorB, partner }) {
  const acceptedA = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/cycle-proposals/${encodeURIComponent(proposalId)}/accept`,
    actor: actorA,
    scopes: ['settlement:write'],
    idempotencyKey: token('accept_a'),
    body: {
      proposal_id: proposalId
    }
  });
  if (acceptedA.status !== 200) throw new Error(`accept A failed: ${JSON.stringify(acceptedA.body)}`);

  const acceptedB = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/cycle-proposals/${encodeURIComponent(proposalId)}/accept`,
    actor: actorB,
    scopes: ['settlement:write'],
    idempotencyKey: token('accept_b'),
    body: {
      proposal_id: proposalId
    }
  });
  if (acceptedB.status !== 200) throw new Error(`accept B failed: ${JSON.stringify(acceptedB.body)}`);

  const deadline = new Date(Date.now() + (6 * 60 * 60 * 1000)).toISOString();

  const started = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/settlement/${encodeURIComponent(proposalId)}/start`,
    actor: partner,
    scopes: ['settlement:write'],
    body: {
      deposit_deadline_at: deadline
    }
  });
  if (started.status !== 200) throw new Error(`settlement start failed: ${JSON.stringify(started.body)}`);

  const depA = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/settlement/${encodeURIComponent(proposalId)}/deposit-confirmed`,
    actor: actorA,
    scopes: ['settlement:write'],
    body: {
      deposit_ref: token('dep_a')
    }
  });
  if (depA.status !== 200) throw new Error(`deposit A failed: ${JSON.stringify(depA.body)}`);

  const depB = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/settlement/${encodeURIComponent(proposalId)}/deposit-confirmed`,
    actor: actorB,
    scopes: ['settlement:write'],
    body: {
      deposit_ref: token('dep_b')
    }
  });
  if (depB.status !== 200) throw new Error(`deposit B failed: ${JSON.stringify(depB.body)}`);

  const begin = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/settlement/${encodeURIComponent(proposalId)}/begin-execution`,
    actor: partner,
    scopes: ['settlement:write'],
    body: {}
  });
  if (begin.status !== 200) throw new Error(`begin execution failed: ${JSON.stringify(begin.body)}`);

  const complete = await requestJson({
    baseUrl,
    method: 'POST',
    path: `/settlement/${encodeURIComponent(proposalId)}/complete`,
    actor: partner,
    scopes: ['settlement:write'],
    body: {}
  });
  if (complete.status !== 200) throw new Error(`complete settlement failed: ${JSON.stringify(complete.body)}`);

  return {
    timeline: complete.body?.timeline ?? null,
    receipt: complete.body?.receipt ?? null
  };
}

export async function loadSchemaValidator() {
  const schemaDir = path.join(repoRoot, 'docs/spec/schemas');
  const fileNames = await fs.readdir(schemaDir);
  const schemaFiles = fileNames.filter(name => name.endsWith('.schema.json')).sort();

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);

  for (const fileName of schemaFiles) {
    const filePath = path.join(schemaDir, fileName);
    const schema = JSON.parse(await fs.readFile(filePath, 'utf8'));
    ajv.addSchema(schema, schema.$id);
    ajv.addSchema(schema, fileName);
  }

  return ajv;
}

export function validateWithSchema(ajv, schemaId, payload) {
  const validate = ajv.getSchema(schemaId) ?? ajv.getSchema(`https://swapgraph.dev/schemas/${schemaId}`) ?? ajv.getSchema(schemaId.split('/').pop());
  if (!validate) {
    throw new Error(`schema not found: ${schemaId}`);
  }

  const pass = validate(payload);
  return {
    pass,
    errors: pass ? [] : (validate.errors ?? []).map(error => ({
      instancePath: error.instancePath,
      schemaPath: error.schemaPath,
      keyword: error.keyword,
      message: error.message
    }))
  };
}
