import test from 'node:test';
import assert from 'node:assert/strict';

import { JsonStateStore } from '../../src/store/jsonStateStore.mjs';
import { MarketService } from '../../src/service/marketService.mjs';
import { MarketAuthService, resolveUserSessionToken } from '../../src/service/marketAuthService.mjs';

function createStore() {
  return new JsonStateStore({
    filePath: `/tmp/swapgraph-market-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  });
}

test('market auth challenge verify issues a bearer session', () => {
  const store = createStore();
  const market = new MarketService({ store });
  const authService = new MarketAuthService({ store, market });

  const start = authService.startChallenge({
    actor: null,
    auth: { client_fingerprint: 'client-a', now_iso: '2026-03-09T12:00:00.000Z' },
    idempotencyKey: 'auth_start_1',
    request: {
      email: 'owner@example.com',
      display_name: 'Owner Example',
      owner_mode: 'builder',
      recorded_at: '2026-03-09T12:00:00.000Z'
    }
  }).result;
  assert.equal(start.ok, true);
  assert.equal(typeof start.body.verification_code, 'string');

  const verify = authService.verifyChallenge({
    actor: null,
    auth: { client_fingerprint: 'client-a', now_iso: '2026-03-09T12:01:00.000Z' },
    idempotencyKey: 'auth_verify_1',
    request: {
      challenge_id: start.body.challenge_id,
      verification_code: start.body.verification_code,
      recorded_at: '2026-03-09T12:01:00.000Z'
    }
  }).result;
  assert.equal(verify.ok, true);
  assert.match(verify.body.session.session_token, /^sgsu1\./);
  assert.equal(verify.body.owner_profile.display_name, 'Owner Example');

  const resolved = resolveUserSessionToken({
    store,
    tokenString: verify.body.session.session_token,
    nowIsoValue: '2026-03-09T12:02:00.000Z'
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.actor.type, 'user');
  assert.ok(resolved.auth.scopes.includes('market:read'));
  assert.ok(resolved.auth.scopes.includes('market:write'));
});

test('moderator email allowlist adds market:moderate scope and logout revokes session', () => {
  process.env.MARKET_MODERATOR_EMAILS = 'ops@example.com';
  const store = createStore();
  const market = new MarketService({ store });
  const authService = new MarketAuthService({ store, market });

  const start = authService.startChallenge({
    actor: null,
    auth: { client_fingerprint: 'client-b', now_iso: '2026-03-09T13:00:00.000Z' },
    idempotencyKey: 'auth_start_ops',
    request: {
      email: 'ops@example.com',
      display_name: 'Ops Example',
      owner_mode: 'operator',
      recorded_at: '2026-03-09T13:00:00.000Z'
    }
  }).result;
  assert.equal(start.ok, true);

  const verify = authService.verifyChallenge({
    actor: null,
    auth: { client_fingerprint: 'client-b', now_iso: '2026-03-09T13:01:00.000Z' },
    idempotencyKey: 'auth_verify_ops',
    request: {
      challenge_id: start.body.challenge_id,
      verification_code: start.body.verification_code,
      recorded_at: '2026-03-09T13:01:00.000Z'
    }
  }).result;
  assert.equal(verify.ok, true);
  assert.ok(verify.body.scopes.includes('market:moderate'));

  const resolved = resolveUserSessionToken({
    store,
    tokenString: verify.body.session.session_token,
    nowIsoValue: '2026-03-09T13:02:00.000Z'
  });
  assert.equal(resolved.ok, true);

  const logout = authService.logout({
    actor: resolved.actor,
    auth: resolved.auth,
    idempotencyKey: 'auth_logout_ops',
    request: { recorded_at: '2026-03-09T13:03:00.000Z' }
  }).result;
  assert.equal(logout.ok, true);

  const revoked = resolveUserSessionToken({
    store,
    tokenString: verify.body.session.session_token,
    nowIsoValue: '2026-03-09T13:04:00.000Z'
  });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, 'session_revoked');
  delete process.env.MARKET_MODERATOR_EMAILS;
});
