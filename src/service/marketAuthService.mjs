import { createHash, randomBytes } from 'node:crypto';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const USER_SESSION_PREFIX = 'sgsu1';
const DEFAULT_USER_SCOPES = Object.freeze([
  'market:read',
  'market:write',
  'receipts:read',
  'payment_proofs:write',
  'execution_grants:write'
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEmail(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function parseIsoMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function nowIso(auth) {
  return normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function nextCounter(store, key) {
  store.state[key] ||= 0;
  store.state[key] += 1;
  return store.state[key];
}

function nextId(store, prefix, counterKey) {
  return `${prefix}_${String(nextCounter(store, counterKey)).padStart(6, '0')}`;
}

function challengeTtlSecs() {
  const parsed = Number.parseInt(String(process.env.MARKET_AUTH_CHALLENGE_TTL_SECS ?? '900'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 900;
}

function sessionTtlSecs() {
  const parsed = Number.parseInt(String(process.env.MARKET_AUTH_SESSION_TTL_SECS ?? '2592000'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2592000;
}

function moderatorEmails() {
  return new Set(String(process.env.MARKET_MODERATOR_EMAILS ?? '')
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(Boolean));
}

function deliveryMode() {
  return normalizeOptionalString(process.env.MARKET_AUTH_DELIVERY_MODE)?.toLowerCase() ?? 'inline_code';
}

function correlationId(prefix) {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: { code, message, details }
  };
}

function ensureAuthState(store) {
  store.state.market_auth_identities ||= {};
  store.state.market_auth_identity_counter ||= 0;
  store.state.market_auth_challenges ||= {};
  store.state.market_auth_challenge_counter ||= 0;
  store.state.market_auth_sessions ||= {};
  store.state.market_auth_session_counter ||= 0;
}

function issueUserSessionToken({ store, actor, email, scopes, recordedAt }) {
  ensureAuthState(store);
  const sessionId = nextId(store, 'masess', 'market_auth_session_counter');
  const secret = randomBytes(24).toString('base64url');
  const expiresAt = new Date((parseIsoMs(recordedAt) ?? Date.now()) + (sessionTtlSecs() * 1000)).toISOString();
  store.state.market_auth_sessions[sessionId] = {
    session_id: sessionId,
    actor: clone(actor),
    email,
    scopes: clone(scopes),
    token_secret_hash: sha256(secret),
    created_at: recordedAt,
    updated_at: recordedAt,
    last_used_at: recordedAt,
    expires_at: expiresAt,
    revoked_at: null
  };
  return {
    session_id: sessionId,
    session_token: `${USER_SESSION_PREFIX}.${sessionId}.${secret}`,
    expires_at: expiresAt
  };
}

export function resolveUserSessionToken({ store, tokenString, nowIsoValue = null }) {
  ensureAuthState(store);
  const raw = normalizeOptionalString(tokenString);
  if (!raw) return { ok: false, error: 'missing_token' };
  const match = /^sgsu1\.([^.]+)\.(.+)$/.exec(raw);
  if (!match) return { ok: false, error: 'invalid_format' };
  const [, sessionId, secret] = match;
  const session = store.state.market_auth_sessions?.[sessionId] ?? null;
  if (!session) return { ok: false, error: 'session_not_found' };
  if (session.revoked_at) return { ok: false, error: 'session_revoked' };
  if (session.token_secret_hash !== sha256(secret)) return { ok: false, error: 'secret_mismatch' };
  const effectiveNow = nowIsoValue ?? new Date().toISOString();
  const nowMs = parseIsoMs(effectiveNow);
  const expMs = parseIsoMs(session.expires_at);
  if (nowMs !== null && expMs !== null && nowMs > expMs) return { ok: false, error: 'session_expired' };
  return {
    ok: true,
    actor: clone(session.actor),
    auth: {
      scopes: clone(session.scopes ?? []),
      market_session: {
        session_id: session.session_id,
        email: session.email,
        expires_at: session.expires_at
      },
      now_iso: effectiveNow
    }
  };
}

export class MarketAuthService {
  constructor({ store, market }) {
    if (!store) throw new Error('store is required');
    if (!market) throw new Error('market is required');
    this.store = store;
    this.market = market;
    ensureAuthState(this.store);
  }

  startChallenge({ actor, auth, idempotencyKey, request }) {
    const corr = correlationId('marketAuthStart');
    if (actor) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'auth start must be anonymous', { reason_code: 'market_auth_already_authenticated' }) } };
    }
    const email = normalizeEmail(request?.email);
    const displayName = normalizeOptionalString(request?.display_name);
    const recordedAt = normalizeOptionalString(request?.recorded_at) ?? nowIso(auth);
    if (!email || !EMAIL_RE.test(email) || !displayName || parseIsoMs(recordedAt) === null) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid auth start payload', { reason_code: 'market_auth_start_invalid' }) } };
    }

    const scopeKey = `anonymous:marketAuth.start:${idempotencyKey}`;
    const payloadHash = sha256(JSON.stringify(request ?? {}));
    const existing = this.store.state.idempotency?.[scopeKey];
    if (existing) {
      if (existing.payload_hash === payloadHash) return { replayed: true, result: clone(existing.result) };
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', { operation_id: 'marketAuth.start', idempotency_key: idempotencyKey }) } };
    }

    const challengeId = nextId(this.store, 'mchallenge', 'market_auth_challenge_counter');
    const verificationCode = String(randomBytes(3).readUIntBE(0, 3) % 1000000).padStart(6, '0');
    const expiresAt = new Date((parseIsoMs(recordedAt) ?? Date.now()) + (challengeTtlSecs() * 1000)).toISOString();
    this.store.state.market_auth_challenges[challengeId] = {
      challenge_id: challengeId,
      email,
      display_name: displayName,
      owner_mode: normalizeOptionalString(request?.owner_mode) ?? 'agent_owner',
      workspace_id: normalizeOptionalString(request?.workspace_id),
      bio: normalizeOptionalString(request?.bio),
      code_hash: sha256(verificationCode),
      created_at: recordedAt,
      updated_at: recordedAt,
      expires_at: expiresAt,
      consumed_at: null
    };

    const result = {
      ok: true,
      body: {
        correlation_id: corr,
        challenge_id: challengeId,
        email,
        expires_at: expiresAt,
        delivery_mode: deliveryMode(),
        verification_code: deliveryMode() === 'inline_code' ? verificationCode : null
      }
    };
    this.store.state.idempotency[scopeKey] = { payload_hash: payloadHash, result: clone(result) };
    return { replayed: false, result };
  }

  verifyChallenge({ actor, auth, idempotencyKey, request }) {
    const corr = correlationId('marketAuthVerify');
    if (actor) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'FORBIDDEN', 'auth verify must be anonymous', { reason_code: 'market_auth_already_authenticated' }) } };
    }
    const challengeId = normalizeOptionalString(request?.challenge_id);
    const verificationCode = normalizeOptionalString(request?.verification_code);
    const recordedAt = normalizeOptionalString(request?.recorded_at) ?? nowIso(auth);
    if (!challengeId || !verificationCode || parseIsoMs(recordedAt) === null) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid auth verify payload', { reason_code: 'market_auth_verify_invalid' }) } };
    }

    const scopeKey = `anonymous:marketAuth.verify:${idempotencyKey}`;
    const payloadHash = sha256(JSON.stringify(request ?? {}));
    const existing = this.store.state.idempotency?.[scopeKey];
    if (existing) {
      if (existing.payload_hash === payloadHash) return { replayed: true, result: clone(existing.result) };
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', { operation_id: 'marketAuth.verify', idempotency_key: idempotencyKey }) } };
    }

    const challenge = this.store.state.market_auth_challenges?.[challengeId] ?? null;
    if (!challenge || challenge.consumed_at) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'NOT_FOUND', 'auth challenge not found', { reason_code: 'market_auth_challenge_not_found', challenge_id: challengeId }) } };
    }
    const nowMs = parseIsoMs(recordedAt);
    const expMs = parseIsoMs(challenge.expires_at);
    if (nowMs === null || expMs === null || nowMs > expMs) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'UNAUTHORIZED', 'auth challenge expired', { reason_code: 'market_auth_challenge_expired', challenge_id: challengeId }) } };
    }
    if (challenge.code_hash !== sha256(verificationCode)) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'UNAUTHORIZED', 'verification code mismatch', { reason_code: 'market_auth_code_invalid', challenge_id: challengeId }) } };
    }

    let identity = this.store.state.market_auth_identities?.[challenge.email] ?? null;
    let sessionActor = identity?.actor ?? null;
    let profile = sessionActor ? this.store.state.market_actor_profiles?.[`${sessionActor.type}:${sessionActor.id}`] ?? null : null;
    const scopes = Array.from(new Set([
      ...DEFAULT_USER_SCOPES,
      ...(moderatorEmails().has(challenge.email) ? ['market:moderate'] : [])
    ])).sort();

    if (!identity || !sessionActor || !profile) {
      const signup = this.market.signup({
        actor: null,
        auth: { client_fingerprint: auth?.client_fingerprint ?? 'market-auth', now_iso: recordedAt },
        idempotencyKey: `market_auth_signup_${challenge.challenge_id}`,
        request: {
          display_name: challenge.display_name,
          owner_mode: challenge.owner_mode,
          workspace_id: challenge.workspace_id ?? undefined,
          bio: challenge.bio ?? undefined,
          recorded_at: recordedAt
        }
      }).result;
      if (!signup.ok) return { replayed: false, result: signup };
      sessionActor = signup.body.actor;
      profile = signup.body.owner_profile;
      identity = {
        identity_id: nextId(this.store, 'midentity', 'market_auth_identity_counter'),
        email: challenge.email,
        actor: clone(sessionActor),
        created_at: recordedAt
      };
    }

    identity.email = challenge.email;
    identity.actor = clone(sessionActor);
    identity.scopes = clone(scopes);
    identity.email_verified_at = recordedAt;
    identity.updated_at = recordedAt;
    this.store.state.market_auth_identities[challenge.email] = identity;
    challenge.consumed_at = recordedAt;
    challenge.updated_at = recordedAt;

    const issued = issueUserSessionToken({
      store: this.store,
      actor: sessionActor,
      email: challenge.email,
      scopes,
      recordedAt
    });

    const result = {
      ok: true,
      body: {
        correlation_id: corr,
        actor: clone(sessionActor),
        owner_profile: clone(profile),
        email: challenge.email,
        scopes: clone(scopes),
        session: issued
      }
    };
    this.store.state.idempotency[scopeKey] = { payload_hash: payloadHash, result: clone(result) };
    return { replayed: false, result };
  }

  getSession({ actor, auth }) {
    const corr = correlationId('marketAuthSession');
    if (!actor || actor.type !== 'user') {
      return { ok: false, body: errorResponse(corr, 'UNAUTHORIZED', 'user session required', { reason_code: 'market_auth_session_required' }) };
    }
    const profile = this.store.state.market_actor_profiles?.[`${actor.type}:${actor.id}`] ?? null;
    const session = auth?.market_session ?? null;
    return {
      ok: true,
      body: {
        correlation_id: corr,
        actor: clone(actor),
        owner_profile: clone(profile),
        email: session?.email ?? null,
        scopes: clone(auth?.scopes ?? []),
        session: session ? clone(session) : null
      }
    };
  }

  logout({ actor, auth, idempotencyKey, request }) {
    const corr = correlationId('marketAuthLogout');
    const sessionId = auth?.market_session?.session_id ?? null;
    const recordedAt = normalizeOptionalString(request?.recorded_at) ?? nowIso(auth);
    if (!actor || actor.type !== 'user' || !sessionId) {
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'UNAUTHORIZED', 'user session required', { reason_code: 'market_auth_session_required' }) } };
    }
    const scopeKey = `${actor.type}:${actor.id}:marketAuth.logout:${idempotencyKey}`;
    const payloadHash = sha256(JSON.stringify(request ?? {}));
    const existing = this.store.state.idempotency?.[scopeKey];
    if (existing) {
      if (existing.payload_hash === payloadHash) return { replayed: true, result: clone(existing.result) };
      return { replayed: false, result: { ok: false, body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', { operation_id: 'marketAuth.logout', idempotency_key: idempotencyKey }) } };
    }
    const session = this.store.state.market_auth_sessions?.[sessionId] ?? null;
    if (session) {
      session.revoked_at = recordedAt;
      session.updated_at = recordedAt;
    }
    const result = {
      ok: true,
      body: {
        correlation_id: corr,
        revoked: true,
        session_id: sessionId
      }
    };
    this.store.state.idempotency[scopeKey] = { payload_hash: payloadHash, result: clone(result) };
    return { replayed: false, result };
  }
}
