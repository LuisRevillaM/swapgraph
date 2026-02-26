#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ApiClientError, MarketplaceApiClient } from '../../client/marketplace/src/api/apiClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const apiClientPath = path.join(repoRoot, 'client/marketplace/src/api/apiClient.mjs');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-sec-02-session-auth-boundary-controls-report.json');

function okResponse(body, status = 200) {
  return {
    ok: true,
    status,
    headers: new Headers({ 'x-correlation-id': 'corr_sec_02' }),
    text: async () => JSON.stringify(body)
  };
}

function sampleIntent(id) {
  return {
    id,
    actor: { type: 'user', id: 'user_1' },
    offer: [{ platform: 'steam', app_id: 730, context_id: 2, asset_id: 'asset_1', metadata: { value_usd: 100 } }],
    want_spec: {
      type: 'set',
      any_of: [{ type: 'category', platform: 'steam', app_id: 730, category: 'knife', constraints: { acceptable_wear: ['MW'] } }]
    },
    value_band: { min_usd: 80, max_usd: 120, pricing_source: 'market_median' },
    trust_constraints: { max_cycle_length: 3, min_counterparty_reliability: 0 },
    time_constraints: { expires_at: '2027-12-31T00:00:00.000Z', urgency: 'normal' },
    settlement_preferences: { require_escrow: true }
  };
}

async function main() {
  let missingScopeError = null;
  const denied = new MarketplaceApiClient({
    fetchImpl: async () => {
      throw new Error('fetch should not be called when scopes are missing');
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'user_1', scopes: ['swap_intents:read'] }),
    getCsrfToken: () => 'csrf_boundary'
  });

  try {
    await denied.createIntent({
      intent: sampleIntent('intent_denied'),
      idempotencyKey: 'idem_denied'
    });
  } catch (error) {
    missingScopeError = error;
  }

  const calls = [];
  const allowed = new MarketplaceApiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return okResponse({ intent: sampleIntent('intent_allowed') });
    },
    getActorContext: () => ({ actorType: 'user', actorId: 'user_1', scopes: ['swap_intents:write'] }),
    getCsrfToken: () => 'csrf_boundary'
  });

  await allowed.createIntent({
    intent: sampleIntent('intent_allowed'),
    idempotencyKey: 'idem_allowed'
  });

  const apiClientSource = readFileSync(apiClientPath, 'utf8');
  const checklist = [
    {
      id: 'missing_scope_rejected_before_request',
      pass: missingScopeError instanceof ApiClientError && missingScopeError.code === 'AUTH_SCOPE_MISSING'
    },
    {
      id: 'mutation_request_has_auth_and_csrf_headers',
      pass: calls.length === 1
        && calls[0].init.headers['x-auth-scopes'] === 'swap_intents:write'
        && calls[0].init.headers['x-csrf-token'] === 'csrf_boundary'
        && calls[0].init.headers['idempotency-key'] === 'idem_allowed'
    },
    {
      id: 'session_boundary_request_options_hardened',
      pass: calls.length === 1
        && calls[0].init.credentials === 'same-origin'
        && calls[0].init.cache === 'no-store'
        && calls[0].init.redirect === 'error'
    },
    {
      id: 'scope_enforcement_present_in_source',
      pass: /AUTH_SCOPE_MISSING/.test(apiClientSource)
    }
  ];

  const output = {
    check_id: 'SC-SEC-02',
    generated_at: new Date().toISOString(),
    source: path.relative(repoRoot, apiClientPath),
    checklist,
    pass: checklist.every(row => row.pass)
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
