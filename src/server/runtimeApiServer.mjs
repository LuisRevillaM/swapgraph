import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAuthHeaders } from '../core/authHeaders.mjs';
import { CommitService } from '../commit/commitService.mjs';
import { ingestPollingResponse } from '../delivery/proposalIngestService.mjs';
import { CycleProposalsReadService } from '../read/cycleProposalsReadService.mjs';
import { SettlementReadService } from '../read/settlementReadService.mjs';
import { CycleProposalsCommitService } from '../service/cycleProposalsCommitService.mjs';
import { CommercialPolicyService } from '../service/commercialPolicyService.mjs';
import { LiquidityAutonomyPolicyService } from '../service/liquidityAutonomyPolicyService.mjs';
import { LiquidityExecutionService } from '../service/liquidityExecutionService.mjs';
import { LiquidityInventoryService } from '../service/liquidityInventoryService.mjs';
import { LiquidityListingDecisionService } from '../service/liquidityListingDecisionService.mjs';
import { LiquidityProviderService } from '../service/liquidityProviderService.mjs';
import { LiquiditySimulationService } from '../service/liquiditySimulationService.mjs';
import { LiquidityTransparencyService } from '../service/liquidityTransparencyService.mjs';
import { MetricsNetworkHealthService } from '../service/metricsNetworkHealthService.mjs';
import { PartnerLiquidityProviderGovernanceService } from '../service/partnerLiquidityProviderGovernanceService.mjs';
import { PlatformInventoryDisputeFacadeService } from '../service/platformInventoryDisputeFacadeService.mjs';
import { ProductSurfaceReadinessService } from '../service/productSurfaceReadinessService.mjs';
import { SettlementWriteApiService } from '../service/settlementWriteApiService.mjs';
import { SwapIntentsService } from '../service/swapIntentsService.mjs';
import { TrustSafetyService } from '../service/trustSafetyService.mjs';
import { JsonStateStore } from '../store/jsonStateStore.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWED_ACTOR_TYPES = new Set(['user', 'partner', 'agent']);

function repoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../..');
}

function toQueryObject(searchParams) {
  const out = {};
  for (const [k, v] of searchParams.entries()) out[k] = v;
  return out;
}

function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseScopes(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return Array.from(new Set(raw.split(/[,\s]+/g).map(x => x.trim()).filter(Boolean))).sort();
}

function errorBody(correlationId, code, message, details = {}) {
  return {
    correlation_id: correlationId,
    error: { code, message, details }
  };
}

function errorStatus(code) {
  switch (code) {
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
    case 'INSUFFICIENT_SCOPE':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
    case 'RESERVATION_CONFLICT':
    case 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH':
      return 409;
    case 'CONSTRAINT_VIOLATION':
      return 400;
    default:
      return 400;
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson({ res, status, body, correlationId }) {
  const corr = body?.correlation_id ?? correlationId ?? randomUUID();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-correlation-id': corr
  });
  res.end(JSON.stringify(body));
}

function parseActorAuth({ req, allowAnonymous = false }) {
  const authz = trimOrNull(req.headers.authorization);
  if (authz?.startsWith('Bearer sgdt1.')) {
    const parsed = parseAuthHeaders({ headers: req.headers });
    if (!parsed.ok) {
      return { ok: false, code: parsed.error.code, message: parsed.error.message, details: parsed.error.details };
    }
    return { ok: true, actor: parsed.actor, auth: parsed.auth };
  }

  const actorTypeHeader = trimOrNull(req.headers['x-actor-type']);
  const actorIdHeader = trimOrNull(req.headers['x-actor-id']);
  const partnerKey = trimOrNull(req.headers['x-partner-key']);

  let actorType = actorTypeHeader;
  let actorId = actorIdHeader;
  if (!actorType && partnerKey) {
    actorType = 'partner';
    actorId = partnerKey;
  }

  if (!actorType || !actorId) {
    if (allowAnonymous) return { ok: true, actor: null, auth: {} };
    return {
      ok: false,
      code: 'UNAUTHORIZED',
      message: 'missing actor identity',
      details: {
        required_headers: ['x-actor-type', 'x-actor-id'],
        optional_partner_shortcut_header: 'x-partner-key'
      }
    };
  }

  if (!ALLOWED_ACTOR_TYPES.has(actorType)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'actor type is not supported',
      details: {
        actor_type: actorType,
        allowed_actor_types: Array.from(ALLOWED_ACTOR_TYPES).sort()
      }
    };
  }

  const scopes = parseScopes(trimOrNull(req.headers['x-auth-scopes']) ?? trimOrNull(req.headers['x-scopes']) ?? '');
  const nowIso = trimOrNull(req.headers['x-now-iso']);
  const auth = { scopes };
  if (nowIso) auth.now_iso = nowIso;

  return {
    ok: true,
    actor: { type: actorType, id: actorId },
    auth
  };
}

function idempotencyKey(req) {
  return trimOrNull(req.headers['idempotency-key']);
}

function requireIdempotencyKey(req) {
  const value = idempotencyKey(req);
  if (value) return { ok: true, value };
  return {
    ok: false,
    code: 'CONSTRAINT_VIOLATION',
    message: 'Idempotency-Key header is required',
    details: { header: 'Idempotency-Key' }
  };
}

function routeMatch(pathname, re) {
  const m = re.exec(pathname);
  if (!m) return null;
  return m.slice(1).map(decodeURIComponent);
}

function summarizeState(store) {
  const liquidityInventorySnapshots = Object.values(store.state.liquidity_inventory_snapshots ?? {})
    .reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0);
  const liquidityInventoryAssets = Object.values(store.state.liquidity_inventory_assets ?? {})
    .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
  const liquidityListings = Object.values(store.state.liquidity_listings ?? {})
    .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
  const liquidityExecutionModes = Object.keys(store.state.liquidity_execution_modes ?? {}).length;
  const liquidityExecutionRequests = Object.keys(store.state.liquidity_execution_requests ?? {}).length;
  const liquidityPolicyExportCheckpoints = Object.values(store.state.liquidity_policy_export_checkpoints ?? {})
    .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);
  const partnerLiquidityProviderRolloutExportCheckpoints = Object.values(store.state.partner_liquidity_provider_rollout_export_checkpoints ?? {})
    .reduce((sum, rows) => sum + Object.keys(rows ?? {}).length, 0);

  return {
    intents: Object.keys(store.state.intents ?? {}).length,
    proposals: Object.keys(store.state.proposals ?? {}).length,
    commits: Object.keys(store.state.commits ?? {}).length,
    timelines: Object.keys(store.state.timelines ?? {}).length,
    receipts: Object.keys(store.state.receipts ?? {}).length,
    events: Array.isArray(store.state.events) ? store.state.events.length : 0,
    idempotency_keys: Object.keys(store.state.idempotency ?? {}).length,
    liquidity_providers: Object.keys(store.state.liquidity_providers ?? {}).length,
    liquidity_provider_personas: Object.keys(store.state.liquidity_provider_personas ?? {}).length,
    liquidity_simulation_sessions: Object.keys(store.state.liquidity_simulation_sessions ?? {}).length,
    liquidity_simulation_events: Array.isArray(store.state.liquidity_simulation_events) ? store.state.liquidity_simulation_events.length : 0,
    liquidity_inventory_snapshots: liquidityInventorySnapshots,
    liquidity_inventory_assets: liquidityInventoryAssets,
    liquidity_inventory_reservations: Object.keys(store.state.liquidity_inventory_reservations ?? {}).length,
    liquidity_inventory_reconciliation_events: Array.isArray(store.state.liquidity_inventory_reconciliation_events) ? store.state.liquidity_inventory_reconciliation_events.length : 0,
    liquidity_listings: liquidityListings,
    liquidity_decisions: Object.keys(store.state.liquidity_decisions ?? {}).length,
    liquidity_execution_modes: liquidityExecutionModes,
    liquidity_execution_requests: liquidityExecutionRequests,
    liquidity_execution_export_checkpoints: Object.keys(store.state.liquidity_execution_export_checkpoints ?? {}).length,
    liquidity_policies: Object.keys(store.state.liquidity_policies ?? {}).length,
    liquidity_policy_decision_audit_entries: Array.isArray(store.state.liquidity_policy_decision_audit) ? store.state.liquidity_policy_decision_audit.length : 0,
    liquidity_policy_export_checkpoints: liquidityPolicyExportCheckpoints,
    partner_liquidity_providers: Object.keys(store.state.partner_liquidity_providers ?? {}).length,
    partner_liquidity_provider_rollout_policies: Object.keys(store.state.partner_liquidity_provider_rollout_policies ?? {}).length,
    partner_liquidity_provider_governance_audit_entries: Array.isArray(store.state.partner_liquidity_provider_governance_audit) ? store.state.partner_liquidity_provider_governance_audit.length : 0,
    partner_liquidity_provider_rollout_export_checkpoints: partnerLiquidityProviderRolloutExportCheckpoints,
    trust_safety_signals: Object.keys(store.state.trust_safety_signals ?? {}).length,
    trust_safety_decisions: Object.keys(store.state.trust_safety_decisions ?? {}).length,
    metrics_network_health_export_checkpoints: Object.keys(store.state.metrics_network_health_export_checkpoints ?? {}).length,
    notification_preferences: Object.keys(store.state.notification_preferences ?? {}).length,
    counterparty_preferences: Object.keys(store.state.counterparty_preferences ?? {}).length,
    commercial_policies: Object.keys(store.state.commercial_policies ?? {}).length,
    commercial_policy_audit_entries: Array.isArray(store.state.commercial_policy_audit) ? store.state.commercial_policy_audit.length : 0
  };
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function seedM5Fixtures({ store, reset, partnerId }) {
  if (reset) {
    const fresh = new JsonStateStore({ filePath: store.filePath });
    store.state = fresh.state;
  }

  const root = repoRoot();
  const input = loadJson(path.join(root, 'fixtures/matching/m5_input.json'));
  const expected = loadJson(path.join(root, 'fixtures/matching/m5_expected.json'));

  for (const intent of input.intents ?? []) {
    store.state.intents[intent.id] = { ...intent, status: intent.status ?? 'active' };
  }

  ingestPollingResponse({
    store,
    actor: { type: 'partner', id: partnerId },
    pollingResponse: { proposals: expected.proposals ?? [] }
  });

  return {
    seeded_intents: (input.intents ?? []).length,
    seeded_proposals: (expected.proposals ?? []).length
  };
}

export function createRuntimeApiServer({
  storePath,
  host = '127.0.0.1',
  port = 3005
}) {
  const resolvedStorePath = path.resolve(storePath ?? path.join(repoRoot(), 'data/runtime-api-state.json'));
  const store = new JsonStateStore({ filePath: resolvedStorePath });
  store.load();

  const swapIntents = new SwapIntentsService({ store });
  const proposalsRead = new CycleProposalsReadService({ store });
  const commitsApi = new CycleProposalsCommitService({ store });
  const commitRead = new CommitService({ store });
  const platformInventoryDisputes = new PlatformInventoryDisputeFacadeService({ store });
  const trustSafety = new TrustSafetyService({ store });
  const metricsNetworkHealth = new MetricsNetworkHealthService({ store });
  const productSurface = new ProductSurfaceReadinessService({ store });
  const commercialPolicy = new CommercialPolicyService({ store });
  const liquidityTransparency = new LiquidityTransparencyService({ store });
  const liquidityProviders = new LiquidityProviderService({ store });
  const liquidityInventory = new LiquidityInventoryService({ store });
  const liquidityListingsDecisions = new LiquidityListingDecisionService({ store });
  const liquidityExecution = new LiquidityExecutionService({ store });
  const liquidityPolicy = new LiquidityAutonomyPolicyService({ store });
  const partnerLiquidityProviders = new PartnerLiquidityProviderGovernanceService({ store });
  const liquiditySimulation = new LiquiditySimulationService({ store });
  const settlementWrite = new SettlementWriteApiService({ store });
  const settlementRead = new SettlementReadService({ store });

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const correlationId = trimOrNull(req.headers['x-correlation-id']) ?? randomUUID();
    let shouldPersist = false;

    try {
      if (method === 'GET' && pathname === '/healthz') {
        return sendJson({
          res,
          status: 200,
          correlationId,
          body: {
            correlation_id: correlationId,
            ok: true,
            uptime_ms: Date.now() - startedAt,
            store_path: resolvedStorePath,
            state: summarizeState(store)
          }
        });
      }

      if (method === 'POST' && pathname === '/dev/seed/m5') {
        const body = await readJsonBody(req);
        const reset = body?.reset !== false;
        const partnerId = trimOrNull(body?.partner_id) ?? 'partner_demo';
        const seedStats = seedM5Fixtures({ store, reset, partnerId });
        store.save();
        return sendJson({
          res,
          status: 200,
          correlationId,
          body: {
            correlation_id: correlationId,
            ok: true,
            partner_id: partnerId,
            reset_applied: reset,
            ...seedStats,
            state: summarizeState(store)
          }
        });
      }

      if (method === 'GET' && pathname === '/dev/state/summary') {
        return sendJson({
          res,
          status: 200,
          correlationId,
          body: {
            correlation_id: correlationId,
            ok: true,
            state: summarizeState(store)
          }
        });
      }

      const authParsed = parseActorAuth({ req });
      if (!authParsed.ok) {
        return sendJson({
          res,
          status: errorStatus(authParsed.code),
          correlationId,
          body: errorBody(correlationId, authParsed.code, authParsed.message, authParsed.details)
        });
      }

      const actor = authParsed.actor;
      const auth = authParsed.auth;

      if (method === 'GET' && pathname === '/platform-connections') {
        const result = platformInventoryDisputes.listPlatformConnections({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/platform-connections') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = platformInventoryDisputes.upsertPlatformConnection({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/inventory/snapshots') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = platformInventoryDisputes.recordInventorySnapshot({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/inventory/assets') {
        const query = toQueryObject(url.searchParams);
        const result = platformInventoryDisputes.listInventoryAssets({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/disputes') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = platformInventoryDisputes.createDisputeFacade({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const disputeGet = routeMatch(pathname, /^\/disputes\/([^/]+)$/);
      if (method === 'GET' && disputeGet) {
        const result = platformInventoryDisputes.getDisputeFacade({ actor, auth, disputeId: disputeGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/trust-safety/signals') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = trustSafety.recordSignal({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/trust-safety/decisions') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = trustSafety.recordDecision({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/trust-safety/decisions/export') {
        const query = toQueryObject(url.searchParams);
        const result = trustSafety.exportDecisions({ actor, auth, query });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/metrics/north-star') {
        const query = toQueryObject(url.searchParams);
        const result = metricsNetworkHealth.getNorthStar({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/metrics/marketplace-funnel') {
        const query = toQueryObject(url.searchParams);
        const result = metricsNetworkHealth.getMarketplaceFunnel({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/metrics/partner-health') {
        const query = toQueryObject(url.searchParams);
        const result = metricsNetworkHealth.getPartnerHealth({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/metrics/safety-health') {
        const query = toQueryObject(url.searchParams);
        const result = metricsNetworkHealth.getSafetyHealth({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/metrics/network-health/export') {
        const query = toQueryObject(url.searchParams);
        const result = metricsNetworkHealth.exportNetworkHealth({ actor, auth, query });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/notifications/preferences') {
        const result = productSurface.getNotificationPreferences({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/notifications/preferences') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = productSurface.upsertNotificationPreferences({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/notifications/inbox') {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.listNotificationInbox({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/counterparty-preferences') {
        const result = liquidityTransparency.getCounterpartyPreferences({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/counterparty-preferences') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityTransparency.upsertCounterpartyPreferences({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/liquidity-providers/directory') {
        const query = toQueryObject(url.searchParams);
        const result = liquidityTransparency.listDirectory({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityDirectoryGet = routeMatch(pathname, /^\/liquidity-providers\/directory\/([^/]+)$/);
      if (method === 'GET' && liquidityDirectoryGet) {
        const result = liquidityTransparency.getDirectoryProvider({
          actor,
          auth,
          providerId: liquidityDirectoryGet[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityDirectoryPersonaList = routeMatch(pathname, /^\/liquidity-providers\/directory\/([^/]+)\/personas$/);
      if (method === 'GET' && liquidityDirectoryPersonaList) {
        const result = liquidityTransparency.listDirectoryPersonas({
          actor,
          auth,
          providerId: liquidityDirectoryPersonaList[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/product-projections/inventory-awakening') {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.getInventoryAwakeningProjection({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/product-projections/cycle-inbox') {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.listCycleInboxProjection({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementTimelineProjection = routeMatch(pathname, /^\/product-projections\/settlement-timeline\/([^/]+)$/);
      if (method === 'GET' && settlementTimelineProjection) {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.getSettlementTimelineProjection({ actor, auth, cycleId: settlementTimelineProjection[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const receiptShareProjection = routeMatch(pathname, /^\/product-projections\/receipt-share\/([^/]+)$/);
      if (method === 'GET' && receiptShareProjection) {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.getReceiptShareProjection({ actor, auth, receiptId: receiptShareProjection[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const proposalCounterpartyDisclosureProjection = routeMatch(pathname, /^\/product-projections\/proposals\/([^/]+)\/counterparty-disclosure$/);
      if (method === 'GET' && proposalCounterpartyDisclosureProjection) {
        const result = liquidityTransparency.getProposalCounterpartyDisclosure({
          actor,
          auth,
          proposalId: proposalCounterpartyDisclosureProjection[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const receiptCounterpartyDisclosureProjection = routeMatch(pathname, /^\/product-projections\/receipts\/([^/]+)\/counterparty-disclosure$/);
      if (method === 'GET' && receiptCounterpartyDisclosureProjection) {
        const result = liquidityTransparency.getReceiptCounterpartyDisclosure({
          actor,
          auth,
          receiptId: receiptCounterpartyDisclosureProjection[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/partner-ui/capabilities') {
        const result = productSurface.getPartnerUiCapabilities({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const partnerUiBundle = routeMatch(pathname, /^\/partner-ui\/bundles\/([^/]+)$/);
      if (method === 'GET' && partnerUiBundle) {
        const query = toQueryObject(url.searchParams);
        const result = productSurface.getPartnerUiBundle({ actor, auth, surface: partnerUiBundle[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/commercial/policies/transaction-fee') {
        const result = commercialPolicy.getTransactionFeePolicy({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/commercial/policies/transaction-fee') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = commercialPolicy.upsertTransactionFeePolicy({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/commercial/policies/subscription-tier') {
        const result = commercialPolicy.getSubscriptionTierPolicy({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/commercial/policies/subscription-tier') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = commercialPolicy.upsertSubscriptionTierPolicy({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/commercial/policies/boost') {
        const result = commercialPolicy.getBoostPolicy({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/commercial/policies/boost') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = commercialPolicy.upsertBoostPolicy({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/commercial/policies/quota') {
        const result = commercialPolicy.getQuotaPolicy({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/commercial/policies/quota') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = commercialPolicy.upsertQuotaPolicy({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'POST' && pathname === '/commercial/policies/evaluate') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = commercialPolicy.evaluatePolicy({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/commercial/policies/export') {
        const query = toQueryObject(url.searchParams);
        const result = commercialPolicy.exportPolicies({ actor, auth, query });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/partner-liquidity-providers') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = partnerLiquidityProviders.onboard({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const partnerLiquidityProviderGet = routeMatch(pathname, /^\/partner-liquidity-providers\/([^/]+)$/);
      if (method === 'GET' && partnerLiquidityProviderGet) {
        const result = partnerLiquidityProviders.get({
          actor,
          auth,
          providerId: partnerLiquidityProviderGet[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const partnerLiquidityProviderStatusUpsert = routeMatch(pathname, /^\/partner-liquidity-providers\/([^/]+)\/status$/);
      if (method === 'POST' && partnerLiquidityProviderStatusUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = partnerLiquidityProviders.upsertStatus({
          actor,
          auth,
          providerId: partnerLiquidityProviderStatusUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const partnerLiquidityProviderEligibilityEvaluate = routeMatch(pathname, /^\/partner-liquidity-providers\/([^/]+)\/eligibility\/evaluate$/);
      if (method === 'POST' && partnerLiquidityProviderEligibilityEvaluate) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = partnerLiquidityProviders.evaluateEligibility({
          actor,
          auth,
          providerId: partnerLiquidityProviderEligibilityEvaluate[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const partnerLiquidityProviderRolloutUpsert = routeMatch(pathname, /^\/partner-liquidity-providers\/([^/]+)\/rollout$/);
      if (method === 'POST' && partnerLiquidityProviderRolloutUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = partnerLiquidityProviders.upsertRollout({
          actor,
          auth,
          providerId: partnerLiquidityProviderRolloutUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const partnerLiquidityProviderRolloutExport = routeMatch(pathname, /^\/partner-liquidity-providers\/([^/]+)\/rollout\/export$/);
      if (method === 'GET' && partnerLiquidityProviderRolloutExport) {
        const query = toQueryObject(url.searchParams);
        const result = partnerLiquidityProviders.exportRollout({
          actor,
          auth,
          providerId: partnerLiquidityProviderRolloutExport[0],
          query
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/liquidity-providers') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityProviders.register({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      if (method === 'GET' && pathname === '/liquidity-providers') {
        const query = toQueryObject(url.searchParams);
        const result = liquidityProviders.list({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityProviderPersonaUpsert = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/persona$/);
      if (method === 'POST' && liquidityProviderPersonaUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityProviders.upsertPersona({
          actor,
          auth,
          providerId: liquidityProviderPersonaUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityProviderGet = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)$/);
      if (method === 'GET' && liquidityProviderGet) {
        const result = liquidityProviders.get({ actor, auth, providerId: liquidityProviderGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityPolicyUpsert = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/policies$/);
      if (method === 'POST' && liquidityPolicyUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityPolicy.upsertPolicy({
          actor,
          auth,
          providerId: liquidityPolicyUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityPolicyGet = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/policies$/);
      if (method === 'GET' && liquidityPolicyGet) {
        const result = liquidityPolicy.getPolicy({
          actor,
          auth,
          providerId: liquidityPolicyGet[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityPolicyEvaluate = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/policies\/evaluate$/);
      if (method === 'POST' && liquidityPolicyEvaluate) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityPolicy.evaluatePolicy({
          actor,
          auth,
          providerId: liquidityPolicyEvaluate[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityDecisionAuditList = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/decision-audit$/);
      if (method === 'GET' && liquidityDecisionAuditList) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityPolicy.listDecisionAudit({
          actor,
          auth,
          providerId: liquidityDecisionAuditList[0],
          query
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityDecisionAuditExport = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/decision-audit\/export$/);
      if (method === 'GET' && liquidityDecisionAuditExport) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityPolicy.exportDecisionAudit({
          actor,
          auth,
          providerId: liquidityDecisionAuditExport[0],
          query
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityInventorySnapshotRecord = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/snapshots$/);
      if (method === 'POST' && liquidityInventorySnapshotRecord) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityInventory.recordSnapshot({
          actor,
          auth,
          providerId: liquidityInventorySnapshotRecord[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityInventoryAssetsList = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/assets$/);
      if (method === 'GET' && liquidityInventoryAssetsList) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityInventory.listAssets({ actor, auth, providerId: liquidityInventoryAssetsList[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityInventoryAvailabilityGet = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/availability$/);
      if (method === 'GET' && liquidityInventoryAvailabilityGet) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityInventory.getAvailability({ actor, auth, providerId: liquidityInventoryAvailabilityGet[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityInventoryReserveBatch = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/reservations$/);
      if (method === 'POST' && liquidityInventoryReserveBatch) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityInventory.reserveBatch({
          actor,
          auth,
          providerId: liquidityInventoryReserveBatch[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityInventoryReleaseBatch = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/reservations\/release$/);
      if (method === 'POST' && liquidityInventoryReleaseBatch) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityInventory.releaseBatch({
          actor,
          auth,
          providerId: liquidityInventoryReleaseBatch[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityInventoryReconciliationExport = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/inventory\/reconciliation\/export$/);
      if (method === 'GET' && liquidityInventoryReconciliationExport) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityInventory.exportReconciliation({ actor, auth, providerId: liquidityInventoryReconciliationExport[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityListingsUpsert = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/listings$/);
      if (method === 'POST' && liquidityListingsUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityListingsDecisions.upsertListing({
          actor,
          auth,
          providerId: liquidityListingsUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityListingsCancel = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/listings\/([^/]+)\/cancel$/);
      if (method === 'POST' && liquidityListingsCancel) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityListingsDecisions.cancelListing({
          actor,
          auth,
          providerId: liquidityListingsCancel[0],
          intentId: liquidityListingsCancel[1],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityListingsList = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/listings$/);
      if (method === 'GET' && liquidityListingsList) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityListingsDecisions.listListings({
          actor,
          auth,
          providerId: liquidityListingsList[0],
          query
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityDecisionAccept = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/proposals\/([^/]+)\/accept$/);
      if (method === 'POST' && liquidityDecisionAccept) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityListingsDecisions.acceptProposalDecision({
          actor,
          auth,
          providerId: liquidityDecisionAccept[0],
          proposalId: liquidityDecisionAccept[1],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityDecisionDecline = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/proposals\/([^/]+)\/decline$/);
      if (method === 'POST' && liquidityDecisionDecline) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityListingsDecisions.declineProposalDecision({
          actor,
          auth,
          providerId: liquidityDecisionDecline[0],
          proposalId: liquidityDecisionDecline[1],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityDecisionGet = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/decisions\/([^/]+)$/);
      if (method === 'GET' && liquidityDecisionGet) {
        const result = liquidityListingsDecisions.getDecision({
          actor,
          auth,
          providerId: liquidityDecisionGet[0],
          decisionId: liquidityDecisionGet[1]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityExecutionModeUpsert = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-mode$/);
      if (method === 'POST' && liquidityExecutionModeUpsert) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityExecution.upsertMode({
          actor,
          auth,
          providerId: liquidityExecutionModeUpsert[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityExecutionModeGet = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-mode$/);
      if (method === 'GET' && liquidityExecutionModeGet) {
        const result = liquidityExecution.getMode({
          actor,
          auth,
          providerId: liquidityExecutionModeGet[0]
        });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquidityExecutionRequestRecord = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-requests$/);
      if (method === 'POST' && liquidityExecutionRequestRecord) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityExecution.recordRequest({
          actor,
          auth,
          providerId: liquidityExecutionRequestRecord[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityExecutionRequestApprove = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-requests\/([^/]+)\/approve$/);
      if (method === 'POST' && liquidityExecutionRequestApprove) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityExecution.approveRequest({
          actor,
          auth,
          providerId: liquidityExecutionRequestApprove[0],
          requestId: liquidityExecutionRequestApprove[1],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityExecutionRequestReject = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-requests\/([^/]+)\/reject$/);
      if (method === 'POST' && liquidityExecutionRequestReject) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquidityExecution.rejectRequest({
          actor,
          auth,
          providerId: liquidityExecutionRequestReject[0],
          requestId: liquidityExecutionRequestReject[1],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquidityExecutionExport = routeMatch(pathname, /^\/liquidity-providers\/([^/]+)\/execution-requests\/export$/);
      if (method === 'GET' && liquidityExecutionExport) {
        const query = toQueryObject(url.searchParams);
        const result = liquidityExecution.exportRequests({
          actor,
          auth,
          providerId: liquidityExecutionExport[0],
          query
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/liquidity-simulation/sessions') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquiditySimulation.startSession({ actor, auth, idempotencyKey: idem.value, request: body });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquiditySimulationGet = routeMatch(pathname, /^\/liquidity-simulation\/sessions\/([^/]+)$/);
      if (method === 'GET' && liquiditySimulationGet) {
        const result = liquiditySimulation.getSession({ actor, auth, sessionId: liquiditySimulationGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquiditySimulationStop = routeMatch(pathname, /^\/liquidity-simulation\/sessions\/([^/]+)\/stop$/);
      if (method === 'POST' && liquiditySimulationStop) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquiditySimulation.stopSession({
          actor,
          auth,
          sessionId: liquiditySimulationStop[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquiditySimulationSyncIntents = routeMatch(pathname, /^\/liquidity-simulation\/sessions\/([^/]+)\/intents\/sync$/);
      if (method === 'POST' && liquiditySimulationSyncIntents) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = liquiditySimulation.syncIntents({
          actor,
          auth,
          sessionId: liquiditySimulationSyncIntents[0],
          idempotencyKey: idem.value,
          request: body
        });
        shouldPersist = true;
        return sendJson({ res, status: out.result.ok ? 200 : errorStatus(out.result.body?.error?.code), correlationId, body: out.result.body });
      }

      const liquiditySimulationCycleExport = routeMatch(pathname, /^\/liquidity-simulation\/sessions\/([^/]+)\/cycles\/export$/);
      if (method === 'GET' && liquiditySimulationCycleExport) {
        const query = toQueryObject(url.searchParams);
        const result = liquiditySimulation.exportCycles({ actor, auth, sessionId: liquiditySimulationCycleExport[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const liquiditySimulationReceiptExport = routeMatch(pathname, /^\/liquidity-simulation\/sessions\/([^/]+)\/receipts\/export$/);
      if (method === 'GET' && liquiditySimulationReceiptExport) {
        const query = toQueryObject(url.searchParams);
        const result = liquiditySimulation.exportReceipts({ actor, auth, sessionId: liquiditySimulationReceiptExport[0], query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const trustSafetyDecisionGet = routeMatch(pathname, /^\/trust-safety\/decisions\/([^/]+)$/);
      if (method === 'GET' && trustSafetyDecisionGet) {
        const result = trustSafety.getDecision({ actor, auth, decisionId: trustSafetyDecisionGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'POST' && pathname === '/swap-intents') {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = swapIntents.create({ actor, auth, idempotencyKey: idem.value, requestBody: body });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const swapIntentId = routeMatch(pathname, /^\/swap-intents\/([^/]+)$/);
      if (method === 'PATCH' && swapIntentId) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = swapIntents.update({
          actor,
          auth,
          id: swapIntentId[0],
          idempotencyKey: idem.value,
          requestBody: body
        });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const swapIntentCancel = routeMatch(pathname, /^\/swap-intents\/([^/]+)\/cancel$/);
      if (method === 'POST' && swapIntentCancel) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const out = swapIntents.cancel({
          actor,
          auth,
          idempotencyKey: idem.value,
          requestBody: { ...body, id: swapIntentCancel[0] }
        });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/swap-intents') {
        const result = swapIntents.list({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && swapIntentId) {
        const result = swapIntents.get({ actor, auth, id: swapIntentId[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/cycle-proposals') {
        const result = proposalsRead.list({ actor, auth });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const proposalIdGet = routeMatch(pathname, /^\/cycle-proposals\/([^/]+)$/);
      if (method === 'GET' && proposalIdGet) {
        const result = proposalsRead.get({ actor, auth, proposalId: proposalIdGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const proposalAccept = routeMatch(pathname, /^\/cycle-proposals\/([^/]+)\/accept$/);
      if (method === 'POST' && proposalAccept) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const proposalId = proposalAccept[0];
        const out = commitsApi.accept({
          actor,
          auth,
          idempotencyKey: idem.value,
          proposalId,
          requestBody: { ...body, proposal_id: body?.proposal_id ?? proposalId },
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const proposalDecline = routeMatch(pathname, /^\/cycle-proposals\/([^/]+)\/decline$/);
      if (method === 'POST' && proposalDecline) {
        const idem = requireIdempotencyKey(req);
        if (!idem.ok) {
          return sendJson({ res, status: 400, correlationId, body: errorBody(correlationId, idem.code, idem.message, idem.details) });
        }
        const body = await readJsonBody(req);
        const proposalId = proposalDecline[0];
        const out = commitsApi.decline({
          actor,
          auth,
          idempotencyKey: idem.value,
          proposalId,
          requestBody: { ...body, proposal_id: body?.proposal_id ?? proposalId },
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        const result = out.result;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const commitIdMatch = routeMatch(pathname, /^\/commits\/([^/]+)$/);
      if (method === 'GET' && commitIdMatch) {
        const result = commitRead.get({ actor, auth, commitId: commitIdMatch[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementStart = routeMatch(pathname, /^\/settlement\/([^/]+)\/start$/);
      if (method === 'POST' && settlementStart) {
        const body = await readJsonBody(req);
        const result = settlementWrite.start({
          actor,
          auth,
          cycleId: settlementStart[0],
          requestBody: body,
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementDeposit = routeMatch(pathname, /^\/settlement\/([^/]+)\/deposit-confirmed$/);
      if (method === 'POST' && settlementDeposit) {
        const body = await readJsonBody(req);
        const result = settlementWrite.depositConfirmed({
          actor,
          auth,
          cycleId: settlementDeposit[0],
          requestBody: body,
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementBegin = routeMatch(pathname, /^\/settlement\/([^/]+)\/begin-execution$/);
      if (method === 'POST' && settlementBegin) {
        const body = await readJsonBody(req);
        const result = settlementWrite.beginExecution({
          actor,
          auth,
          cycleId: settlementBegin[0],
          requestBody: body,
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementComplete = routeMatch(pathname, /^\/settlement\/([^/]+)\/complete$/);
      if (method === 'POST' && settlementComplete) {
        const body = await readJsonBody(req);
        const result = settlementWrite.complete({
          actor,
          auth,
          cycleId: settlementComplete[0],
          requestBody: body,
          occurredAt: trimOrNull(body?.occurred_at) ?? new Date().toISOString()
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementExpire = routeMatch(pathname, /^\/settlement\/([^/]+)\/expire-deposit-window$/);
      if (method === 'POST' && settlementExpire) {
        const body = await readJsonBody(req);
        const result = settlementWrite.expireDepositWindow({
          actor,
          auth,
          cycleId: settlementExpire[0],
          requestBody: body
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementStatus = routeMatch(pathname, /^\/settlement\/([^/]+)\/status$/);
      if (method === 'GET' && settlementStatus) {
        const result = settlementRead.status({ actor, auth, cycleId: settlementStatus[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementInstructions = routeMatch(pathname, /^\/settlement\/([^/]+)\/instructions$/);
      if (method === 'GET' && settlementInstructions) {
        const result = settlementRead.instructions({ actor, auth, cycleId: settlementInstructions[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const settlementVaultExport = routeMatch(pathname, /^\/settlement\/([^/]+)\/vault-reconciliation\/export$/);
      if (method === 'GET' && settlementVaultExport) {
        const query = toQueryObject(url.searchParams);
        const result = settlementRead.vaultReconciliationExport({
          actor,
          auth,
          cycleId: settlementVaultExport[0],
          query
        });
        shouldPersist = true;
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      if (method === 'GET' && pathname === '/partner-program/vault-export') {
        const query = toQueryObject(url.searchParams);
        const result = settlementRead.vaultExportPartnerProgram({ actor, auth, query });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      const receiptGet = routeMatch(pathname, /^\/receipts\/([^/]+)$/);
      if (method === 'GET' && receiptGet) {
        const result = settlementRead.receipt({ actor, auth, cycleId: receiptGet[0] });
        return sendJson({ res, status: result.ok ? 200 : errorStatus(result.body?.error?.code), correlationId, body: result.body });
      }

      return sendJson({
        res,
        status: 404,
        correlationId,
        body: errorBody(correlationId, 'NOT_FOUND', 'route not found', { method, path: pathname })
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      return sendJson({
        res,
        status: 500,
        correlationId,
        body: errorBody(correlationId, 'INTERNAL', message, {})
      });
    } finally {
      if (shouldPersist) {
        try {
          store.save();
        } catch (err) {
          // Persist errors are surfaced as server logs to avoid masking the original response.
          console.error('[runtime-api] failed to persist state:', err);
        }
      }
    }
  });

  return {
    host,
    port,
    storePath: resolvedStorePath,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    }
  };
}
