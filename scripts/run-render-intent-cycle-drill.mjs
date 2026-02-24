import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_SERVICE_URL = 'https://swapgraph-runtime-api.onrender.com';
const DEFAULT_RUNS = 2;

function trimOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return parsed;
}

function parseNonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function tokenUtc(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jsonParseSafe(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

function retryableStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function retryableNetworkError(error) {
  const code = String(error?.code ?? error?.cause?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('fetch failed')) return true;
  if (!code) return String(error?.name ?? '') === 'AbortError';
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT'
  ].includes(code);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function httpJson({
  serviceUrl,
  route,
  method = 'GET',
  headers = {},
  body,
  okStatuses = [200],
  retriesOverride,
  timeoutMsOverride
}) {
  const retries = parsePositiveInt(
    retriesOverride,
    parsePositiveInt(process.env.DRILL_HTTP_RETRIES, 6)
  );
  const timeoutMs = parsePositiveInt(
    timeoutMsOverride,
    parsePositiveInt(process.env.DRILL_HTTP_TIMEOUT_MS, 15000)
  );
  const backoffBaseMs = parsePositiveInt(process.env.DRILL_HTTP_BACKOFF_BASE_MS, 500);
  const backoffMaxMs = parsePositiveInt(process.env.DRILL_HTTP_BACKOFF_MAX_MS, 10000);

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response = null;

      try {
        response = await fetch(`${serviceUrl}${route}`, {
          method,
          headers: {
            accept: 'application/json',
            ...headers
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }

      const text = await response.text();
      const parsed = jsonParseSafe(text);

      if (!okStatuses.includes(response.status)) {
        const err = new Error(`HTTP ${response.status} ${method} ${route}`);
        err.status = response.status;
        err.body = parsed;
        if (attempt + 1 < retries && retryableStatus(response.status)) {
          const delayMs = Math.min(backoffMaxMs, backoffBaseMs * (2 ** attempt)) + Math.floor(Math.random() * 250);
          await sleep(delayMs);
          continue;
        }
        throw err;
      }

      return {
        status: response.status,
        body: parsed
      };
    } catch (error) {
      if (attempt + 1 < retries && retryableNetworkError(error)) {
        const delayMs = Math.min(backoffMaxMs, backoffBaseMs * (2 ** attempt)) + Math.floor(Math.random() * 250);
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error(`request exhausted retries: ${method} ${route}`);
}

function headersFor({ actorType, actorId, scopes, idempotencyKey }) {
  const headers = {
    'content-type': 'application/json',
    'x-actor-type': actorType,
    'x-actor-id': actorId,
    'x-auth-scopes': scopes.join(' ')
  };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return headers;
}

function intentPayload({ intentId, actor, offerAssetId, wantAssetId, valueUsd }) {
  return {
    intent: {
      id: intentId,
      actor,
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

function errorSummary(error) {
  return {
    message: String(error?.message ?? error),
    code: trimOrNull(error?.code ?? null),
    cause_code: trimOrNull(error?.cause?.code ?? null),
    status: Number.isFinite(Number(error?.status)) ? Number(error.status) : null,
    body: error?.body ?? null
  };
}

function nonceToken(index) {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${index}`;
}

function isRetryablePassRecord(pass) {
  const status = Number(pass?.error?.status);
  if (retryableStatus(status)) return true;

  const message = String(pass?.error?.message ?? '').toLowerCase();
  if (message.includes('fetch failed')) return true;
  if (message.includes('timed out')) return true;
  if (message.includes('econn')) return true;
  if (message.includes('socket')) return true;

  return false;
}

async function stabilizeHealth({
  serviceUrl,
  requiredStreak = 2,
  timeoutMs = 90000,
  pollMs = 2000
}) {
  const startedAtMs = Date.now();
  let consecutiveOk = 0;
  let attempts = 0;
  let lastError = null;
  let lastHealth = null;

  while (Date.now() - startedAtMs < timeoutMs) {
    attempts += 1;
    try {
      const response = await httpJson({
        serviceUrl,
        route: '/healthz',
        method: 'GET',
        okStatuses: [200],
        retriesOverride: 2,
        timeoutMsOverride: 12000
      });
      lastHealth = response.body ?? null;
      if (response.body?.ok === true) {
        consecutiveOk += 1;
        if (consecutiveOk >= requiredStreak) {
          return {
            ok: true,
            attempts,
            consecutive_ok: consecutiveOk,
            last_health: response.body
          };
        }
      } else {
        consecutiveOk = 0;
      }
    } catch (error) {
      consecutiveOk = 0;
      lastError = errorSummary(error);
    }
    await sleep(pollMs);
  }

  const timeoutError = new Error(`health stabilization timed out after ${timeoutMs}ms`);
  timeoutError.details = {
    attempts,
    required_streak: requiredStreak,
    last_error: lastError,
    last_health: lastHealth
  };
  throw timeoutError;
}

async function runPass({ serviceUrl, passIndex, maxProposals }) {
  const startedAt = new Date().toISOString();
  const nonce = nonceToken(passIndex);
  const short = nonce.slice(0, 8);
  const actorUserA = { type: 'user', id: `user_drill_a_${short}` };
  const actorUserB = { type: 'user', id: `user_drill_b_${short}` };
  const actorPartner = { type: 'partner', id: 'marketplace' };
  const assets = {
    asset_a: `drill_asset_a_${nonce}`,
    asset_b: `drill_asset_b_${nonce}`
  };
  const intentAId = `intent_drill_a_${nonce}`;
  const intentBId = `intent_drill_b_${nonce}`;
  const operations = [];

  let run = null;
  let matchedProposalId = null;
  const created = [];

  const pass = {
    kind: 'render_intent_cycle_drill',
    started_at: startedAt,
    finished_at: null,
    ok: false,
    service_url: serviceUrl,
    actors: {
      user_a: actorUserA,
      user_b: actorUserB,
      partner: actorPartner
    },
    assets,
    intents: {
      intent_a: intentAId,
      intent_b: intentBId
    },
    run: null,
    matched_proposal_id: null,
    operations,
    cleanup: {
      attempted: false,
      ok: false,
      intents: []
    },
    error: null
  };

  try {
    const health = await httpJson({
      serviceUrl,
      route: '/healthz',
      method: 'GET',
      okStatuses: [200]
    });
    operations.push({
      op: 'healthz',
      status: health.status,
      store_backend: health.body?.store_backend ?? null,
      persistence_mode: health.body?.persistence_mode ?? null
    });

    const createA = await httpJson({
      serviceUrl,
      route: '/swap-intents',
      method: 'POST',
      headers: headersFor({
        actorType: actorUserA.type,
        actorId: actorUserA.id,
        scopes: ['swap_intents:write'],
        idempotencyKey: `drill-intent-a-${nonce}`
      }),
      body: intentPayload({
        intentId: intentAId,
        actor: actorUserA,
        offerAssetId: assets.asset_a,
        wantAssetId: assets.asset_b,
        valueUsd: 100
      }),
      okStatuses: [200]
    });
    created.push({ intentId: intentAId, actor: actorUserA });
    operations.push({
      op: 'swap_intents.create',
      actor_id: actorUserA.id,
      intent_id: createA.body?.intent?.id ?? intentAId,
      status: createA.status
    });

    const createB = await httpJson({
      serviceUrl,
      route: '/swap-intents',
      method: 'POST',
      headers: headersFor({
        actorType: actorUserB.type,
        actorId: actorUserB.id,
        scopes: ['swap_intents:write'],
        idempotencyKey: `drill-intent-b-${nonce}`
      }),
      body: intentPayload({
        intentId: intentBId,
        actor: actorUserB,
        offerAssetId: assets.asset_b,
        wantAssetId: assets.asset_a,
        valueUsd: 101
      }),
      okStatuses: [200]
    });
    created.push({ intentId: intentBId, actor: actorUserB });
    operations.push({
      op: 'swap_intents.create',
      actor_id: actorUserB.id,
      intent_id: createB.body?.intent?.id ?? intentBId,
      status: createB.status
    });

    const runCreate = await httpJson({
      serviceUrl,
      route: '/marketplace/matching/runs',
      method: 'POST',
      headers: headersFor({
        actorType: actorPartner.type,
        actorId: actorPartner.id,
        scopes: ['settlement:write'],
        idempotencyKey: `drill-run-${nonce}`
      }),
      body: {
        replace_existing: true,
        max_proposals: maxProposals
      },
      okStatuses: [200]
    });

    const runId = trimOrNull(runCreate.body?.run?.run_id);
    operations.push({
      op: 'marketplace.matching.run',
      run_id: runId,
      selected_proposals_count: Number(runCreate.body?.run?.selected_proposals_count ?? 0),
      status: runCreate.status
    });
    if (!runId) throw new Error('matching run did not return run_id');

    const runGet = await httpJson({
      serviceUrl,
      route: `/marketplace/matching/runs/${encodeURIComponent(runId)}`,
      method: 'GET',
      headers: headersFor({
        actorType: actorPartner.type,
        actorId: actorPartner.id,
        scopes: ['settlement:read']
      }),
      okStatuses: [200]
    });

    const proposalIds = Array.isArray(runGet.body?.run?.proposal_ids)
      ? runGet.body.run.proposal_ids.filter(v => typeof v === 'string' && v.length > 0)
      : [];
    run = {
      run_id: runId,
      selected_proposals_count: Number(runGet.body?.run?.selected_proposals_count ?? 0),
      candidate_cycles: Number(runGet.body?.run?.stats?.candidate_cycles ?? 0),
      candidate_proposals: Number(runGet.body?.run?.stats?.candidate_proposals ?? 0),
      proposal_ids: proposalIds
    };
    operations.push({
      op: 'marketplace.matching.run.get',
      run_id: runId,
      selected_proposals_count: run.selected_proposals_count,
      candidate_cycles: run.candidate_cycles,
      candidate_proposals: run.candidate_proposals,
      proposal_ids_count: proposalIds.length,
      status: runGet.status
    });

    if (run.selected_proposals_count < 1) {
      throw new Error(`drill expected >=1 selected proposal, got ${run.selected_proposals_count}`);
    }
    if (proposalIds.length < 1) {
      throw new Error('drill expected proposal_ids in run.get response');
    }

    for (const proposalId of proposalIds) {
      const proposalGet = await httpJson({
        serviceUrl,
        route: `/cycle-proposals/${encodeURIComponent(proposalId)}`,
        method: 'GET',
        headers: headersFor({
          actorType: actorPartner.type,
          actorId: actorPartner.id,
          scopes: ['cycle_proposals:read']
        }),
        okStatuses: [200]
      });

      const participants = Array.isArray(proposalGet.body?.proposal?.participants)
        ? proposalGet.body.proposal.participants
        : [];
      const participantIntentIds = participants
        .map(row => trimOrNull(row?.intent_id))
        .filter(Boolean);
      const hasBoth = participantIntentIds.includes(intentAId) && participantIntentIds.includes(intentBId);

      operations.push({
        op: 'cycle_proposals.get',
        proposal_id: proposalId,
        participant_intents_count: participantIntentIds.length,
        has_drill_pair: hasBoth,
        status: proposalGet.status
      });

      if (hasBoth) {
        matchedProposalId = proposalId;
        break;
      }
    }

    if (!matchedProposalId) {
      throw new Error('drill pair intents were not found together in selected proposals');
    }

    pass.ok = true;
    pass.run = run;
    pass.matched_proposal_id = matchedProposalId;
  } catch (error) {
    pass.error = errorSummary(error);
  } finally {
    pass.cleanup.attempted = true;

    const cleanupRows = [];
    for (const row of created) {
      const cleanupRec = {
        intent_id: row.intentId,
        actor_id: row.actor.id,
        cancel_ok: false,
        cancel_status_code: null,
        cancel_status: null,
        listed_status: null,
        error: null
      };

      try {
        const cancelResponse = await httpJson({
          serviceUrl,
          route: `/swap-intents/${encodeURIComponent(row.intentId)}/cancel`,
          method: 'POST',
          headers: headersFor({
            actorType: row.actor.type,
            actorId: row.actor.id,
            scopes: ['swap_intents:write'],
            idempotencyKey: `drill-cancel-${row.intentId}`
          }),
          body: { id: row.intentId },
          okStatuses: [200]
        });
        cleanupRec.cancel_status_code = cancelResponse.status;
        cleanupRec.cancel_status = trimOrNull(cancelResponse.body?.status);

        const listResponse = await httpJson({
          serviceUrl,
          route: '/swap-intents',
          method: 'GET',
          headers: headersFor({
            actorType: row.actor.type,
            actorId: row.actor.id,
            scopes: ['swap_intents:read']
          }),
          okStatuses: [200]
        });
        const intents = Array.isArray(listResponse.body?.intents) ? listResponse.body.intents : [];
        const found = intents.find(intent => intent?.id === row.intentId) ?? null;
        cleanupRec.listed_status = trimOrNull(found?.status);
        cleanupRec.cancel_ok = cleanupRec.listed_status === 'cancelled' || cleanupRec.cancel_status === 'cancelled';
      } catch (error) {
        cleanupRec.error = errorSummary(error);
      }

      cleanupRows.push(cleanupRec);
    }

    pass.cleanup.intents = cleanupRows;
    pass.cleanup.ok = cleanupRows.every(row => row.cancel_ok === true);
    operations.push({
      op: 'cleanup.cancel',
      intents_count: cleanupRows.length,
      cancelled_count: cleanupRows.filter(row => row.cancel_ok).length
    });

    if (pass.ok && !pass.cleanup.ok) {
      pass.ok = false;
      pass.error = {
        message: 'cleanup did not verify cancelled status for all created intents',
        status: null,
        body: cleanupRows
      };
    }

    pass.finished_at = new Date().toISOString();
  }

  return pass;
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const outDir = process.env.DRILL_OUT_DIR ?? path.join(process.cwd(), 'artifacts', 'drills');
mkdirSync(outDir, { recursive: true });

const serviceUrl = (
  trimOrNull(process.env.RUNTIME_SERVICE_URL)
  ?? trimOrNull(process.env.RENDER_SERVICE_URL)
  ?? DEFAULT_SERVICE_URL
).replace(/\/+$/g, '');
const runsRequested = parsePositiveInt(process.env.DRILL_RUNS, DEFAULT_RUNS);
const maxProposals = parsePositiveInt(process.env.DRILL_MAX_PROPOSALS, 200);
const passRetries = parseNonNegativeInt(process.env.DRILL_PASS_RETRIES, 1);
const passRetryBackoffMs = parsePositiveInt(process.env.DRILL_PASS_RETRY_BACKOFF_MS, 2000);
const healthStabilizationEnabled = parseBooleanFlag(process.env.DRILL_HEALTH_STABILIZE, true);
const healthStabilizationTimeoutMs = parsePositiveInt(process.env.DRILL_HEALTH_STABILIZE_TIMEOUT_MS, 90000);
const healthStabilizationPollMs = parsePositiveInt(process.env.DRILL_HEALTH_STABILIZE_POLL_MS, 2000);
const healthStabilizationStreak = parsePositiveInt(process.env.DRILL_HEALTH_STABILIZE_STREAK, 2);

const startedAt = new Date().toISOString();
const passRecords = [];
let preflight = {
  enabled: healthStabilizationEnabled,
  ok: false,
  attempts: 0,
  required_streak: healthStabilizationStreak,
  timeout_ms: healthStabilizationTimeoutMs,
  poll_ms: healthStabilizationPollMs,
  error: null,
  last_health: null
};

if (healthStabilizationEnabled) {
  try {
    const stabilized = await stabilizeHealth({
      serviceUrl,
      requiredStreak: healthStabilizationStreak,
      timeoutMs: healthStabilizationTimeoutMs,
      pollMs: healthStabilizationPollMs
    });
    preflight = {
      ...preflight,
      ok: true,
      attempts: stabilized.attempts,
      last_health: stabilized.last_health
    };
  } catch (error) {
    preflight = {
      ...preflight,
      ok: false,
      error: errorSummary(error),
      attempts: Number(error?.details?.attempts ?? 0),
      last_health: error?.details?.last_health ?? null
    };
  }
} else {
  preflight.ok = true;
}

for (let idx = 1; idx <= runsRequested; idx += 1) {
  const attempts = [];
  let finalPass = null;

  for (let attempt = 0; attempt <= passRetries; attempt += 1) {
    if (attempt > 0 && healthStabilizationEnabled) {
      try {
        await stabilizeHealth({
          serviceUrl,
          requiredStreak: 1,
          timeoutMs: Math.min(30000, healthStabilizationTimeoutMs),
          pollMs: healthStabilizationPollMs
        });
      } catch {
        // Retry path should still attempt the pass even if stabilization does not succeed quickly.
      }
    }

    const pass = await runPass({ serviceUrl, passIndex: idx, maxProposals });
    pass.retry = {
      attempt: attempt + 1,
      max_attempts: passRetries + 1
    };
    attempts.push({
      attempt: attempt + 1,
      ok: pass.ok,
      run_id: pass.run?.run_id ?? null,
      error_message: pass.error?.message ?? null,
      status: pass.error?.status ?? null
    });

    const retryable = !pass.ok && isRetryablePassRecord(pass);
    const hasAttemptsRemaining = attempt < passRetries;
    if (!retryable || !hasAttemptsRemaining || pass.ok) {
      finalPass = pass;
      break;
    }

    const retryDelayMs = Math.min(12000, passRetryBackoffMs * (2 ** attempt));
    await sleep(retryDelayMs);
  }

  const pass = finalPass ?? await runPass({ serviceUrl, passIndex: idx, maxProposals });
  const file = `render-intent-cycle-drill-${tokenUtc()}-p${String(idx).padStart(2, '0')}.json`;
  writeJson(path.join(outDir, file), pass);

  passRecords.push({
    index: idx,
    file,
    ok: pass.ok,
    run_id: pass.run?.run_id ?? null,
    selected_proposals_count: pass.run?.selected_proposals_count ?? null,
    candidate_cycles: pass.run?.candidate_cycles ?? null,
    matched_proposal_id: pass.matched_proposal_id ?? null,
    cleanup_ok: pass.cleanup?.ok === true,
    error_message: pass.error?.message ?? null,
    attempts_count: attempts.length,
    attempts,
    pass: clone(pass)
  });
}

const latestPass = passRecords[passRecords.length - 1]?.pass ?? null;
if (latestPass) {
  writeJson(path.join(outDir, 'latest-render-intent-cycle-drill.json'), latestPass);
}

const successCount = passRecords.filter(row => row.ok).length;
const failureCount = passRecords.length - successCount;
const summary = {
  kind: 'render_intent_cycle_drill_summary',
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  ok: failureCount === 0,
  service_url: serviceUrl,
  preflight,
  pass_retries: passRetries,
  runs_requested: runsRequested,
  runs_completed: passRecords.length,
  success_count: successCount,
  failure_count: failureCount,
  results: passRecords.map(row => ({
    index: row.index,
    file: row.file,
    ok: row.ok,
    run_id: row.run_id,
    selected_proposals_count: row.selected_proposals_count,
    candidate_cycles: row.candidate_cycles,
    matched_proposal_id: row.matched_proposal_id,
    cleanup_ok: row.cleanup_ok,
    error_message: row.error_message,
    attempts_count: row.attempts_count,
    attempts: row.attempts
  }))
};

const summaryFile = `render-intent-cycle-drill-summary-${tokenUtc()}.json`;
writeJson(path.join(outDir, summaryFile), summary);
writeJson(path.join(outDir, 'latest-render-intent-cycle-drill-summary.json'), summary);

console.log(JSON.stringify({
  ok: summary.ok,
  service_url: serviceUrl,
  runs_requested: runsRequested,
  success_count: successCount,
  failure_count: failureCount,
  summary_file: summaryFile,
  run_ids: passRecords.map(row => row.run_id).filter(Boolean)
}, null, 2));

if (!summary.ok) process.exitCode = 1;
