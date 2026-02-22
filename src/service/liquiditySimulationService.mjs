import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

const ACTOR_TYPES = new Set(['user', 'partner', 'agent']);
const SESSION_MODE = 'simulation';
const INTENT_STATUSES = new Set(['active', 'cancelled']);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 200);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorResponse(correlationIdValue, code, message, details = {}) {
  return {
    correlation_id: correlationIdValue,
    error: {
      code,
      message,
      details
    }
  };
}

function ensureState(store) {
  store.state.idempotency ||= {};
  store.state.liquidity_simulation_sessions ||= {};
  store.state.liquidity_simulation_events ||= [];
  store.state.liquidity_simulation_session_counter ||= 0;
}

function nextSessionId(store) {
  store.state.liquidity_simulation_session_counter += 1;
  return `lsim_${String(store.state.liquidity_simulation_session_counter).padStart(6, '0')}`;
}

function sessionView(session) {
  const intents = Object.values(session.intents ?? {});
  const activeIntentsCount = intents.filter(intent => intent.status === 'active').length;
  return {
    session_id: session.session_id,
    simulation: true,
    simulation_session_id: session.session_id,
    owner_actor: clone(session.owner_actor),
    mode: session.mode,
    label: session.label,
    seed: session.seed ?? null,
    status: session.status,
    started_at: session.started_at,
    updated_at: session.updated_at,
    stopped_at: session.stopped_at ?? null,
    counters: {
      sync_calls: session.counters?.sync_calls ?? 0,
      intents_synced_total: session.counters?.intents_synced_total ?? 0,
      active_intents_count: activeIntentsCount,
      cycles_generated_total: session.counters?.cycles_generated_total ?? 0,
      receipts_generated_total: session.counters?.receipts_generated_total ?? 0
    }
  };
}

function normalizeLiquidityProviderSummary(receiptParticipants) {
  const byProviderId = new Map();
  for (const participant of receiptParticipants) {
    const provider = participant?.liquidity_provider_ref;
    const providerId = normalizeOptionalString(provider?.provider_id);
    if (!provider || !providerId) continue;
    if (!byProviderId.has(providerId)) {
      byProviderId.set(providerId, {
        provider: clone(provider),
        participant_count: 0,
        counterparty_intent_ids: new Set()
      });
    }

    const row = byProviderId.get(providerId);
    row.participant_count += 1;
    row.counterparty_intent_ids.add(participant.intent_id);
  }

  return Array.from(byProviderId.values())
    .map(row => ({
      provider: row.provider,
      participant_count: row.participant_count,
      counterparty_intent_ids: Array.from(row.counterparty_intent_ids).sort()
    }))
    .sort((a, b) => String(a.provider?.provider_id ?? '').localeCompare(String(b.provider?.provider_id ?? '')));
}

function normalizeIntentRecord(intent, syncedAt) {
  return {
    intent_id: intent.intent_id,
    actor: clone(intent.actor),
    value_usd: intent.value_usd,
    status: intent.status,
    liquidity_provider_ref: intent.liquidity_provider_ref ? clone(intent.liquidity_provider_ref) : undefined,
    persona_ref: intent.persona_ref ? clone(intent.persona_ref) : undefined,
    liquidity_policy_ref: intent.liquidity_policy_ref ? clone(intent.liquidity_policy_ref) : undefined,
    synced_at: syncedAt
  };
}

function normalizeCycleEntry(cycle) {
  return {
    cycle_id: cycle.cycle_id,
    simulation: true,
    simulation_session_id: cycle.simulation_session_id,
    completed_at: cycle.completed_at,
    confidence_score: cycle.confidence_score,
    participants: clone(cycle.participants ?? [])
  };
}

function normalizeReceiptEntry(receipt) {
  return {
    receipt_id: receipt.receipt_id,
    cycle_id: receipt.cycle_id,
    simulation: true,
    simulation_session_id: receipt.simulation_session_id,
    final_state: receipt.final_state,
    created_at: receipt.created_at,
    intent_ids: clone(receipt.intent_ids ?? []),
    liquidity_provider_summary: clone(receipt.liquidity_provider_summary ?? [])
  };
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return null;
  const type = normalizeOptionalString(actor.type);
  const id = normalizeOptionalString(actor.id);
  if (!type || !id || !ACTOR_TYPES.has(type)) return null;
  return { type, id };
}

function parseExportQuery(query) {
  const allowed = new Set(['limit', 'cursor_after']);
  const unknown = Object.keys(query ?? {}).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason_code: 'liquidity_simulation_export_query_invalid',
      details: { unknown_query_params: unknown.sort() }
    };
  }

  const limit = parseLimit(query?.limit, 50);
  if (limit === null) {
    return {
      ok: false,
      reason_code: 'liquidity_simulation_export_query_invalid',
      details: { limit: query?.limit ?? null }
    };
  }

  const cursorAfter = normalizeOptionalString(query?.cursor_after);
  return { ok: true, limit, cursor_after: cursorAfter };
}

function sessionOwnerMismatch(actor, session) {
  return session?.owner_actor?.type !== actor?.type || session?.owner_actor?.id !== actor?.id;
}

export class LiquiditySimulationService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
  }

  _nowIso(auth) {
    return normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
  }

  _authorize({ actor, auth, operationId, correlationId: corr }) {
    const authz = authorizeApiOperation({ operationId, actor, auth, store: this.store });
    if (!authz.ok) {
      return {
        ok: false,
        body: errorResponse(corr, authz.error.code, authz.error.message, authz.error.details)
      };
    }
    return { ok: true };
  }

  _requirePartner({ actor, operationId, correlationId: corr }) {
    if (actor?.type === 'partner' && normalizeOptionalString(actor?.id)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for simulation operations', {
        operation_id: operationId,
        reason_code: 'liquidity_simulation_invalid',
        actor: actor ?? null
      })
    };
  }

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return { replayed: true, result: clone(existing.result) };
      }
      return {
        replayed: false,
        result: {
          ok: false,
          body: errorResponse(corr, 'IDEMPOTENCY_KEY_REUSE_PAYLOAD_MISMATCH', 'idempotency key reused with a different payload', {
            operation_id: operationId,
            idempotency_key: idempotencyKey
          })
        }
      };
    }

    const result = handler();
    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: clone(result)
    };
    return { replayed: false, result };
  }

  _resolveSessionForActor({ actor, sessionId, correlationId: corr }) {
    const normalizedSessionId = normalizeOptionalString(sessionId);
    if (!normalizedSessionId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'session_id is required', {
          reason_code: 'liquidity_simulation_invalid'
        })
      };
    }

    const session = this.store.state.liquidity_simulation_sessions[normalizedSessionId];
    if (!session || sessionOwnerMismatch(actor, session)) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'simulation session not found', {
          reason_code: 'liquidity_simulation_session_not_found',
          session_id: normalizedSessionId
        })
      };
    }

    return { ok: true, session_id: normalizedSessionId, session };
  }

  startSession({ actor, auth, idempotencyKey, request }) {
    const op = 'liquiditySimulation.session.start';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const startedAt = normalizeOptionalString(request?.started_at) ?? this._nowIso(auth);
        if (parseIsoMs(startedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation start timestamp', {
              reason_code: 'liquidity_simulation_payload_invalid',
              started_at: request?.started_at ?? null
            })
          };
        }

        const sessionReq = request?.session;
        if (!sessionReq || typeof sessionReq !== 'object' || Array.isArray(sessionReq)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation session payload', {
              reason_code: 'liquidity_simulation_payload_invalid'
            })
          };
        }

        const sessionMode = normalizeOptionalString(sessionReq.mode) ?? SESSION_MODE;
        if (sessionMode !== SESSION_MODE) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'simulation session mode must be simulation', {
              reason_code: 'liquidity_simulation_payload_invalid',
              mode: sessionReq.mode ?? null
            })
          };
        }

        const label = normalizeOptionalString(sessionReq.label);
        if (!label) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'simulation session label is required', {
              reason_code: 'liquidity_simulation_payload_invalid'
            })
          };
        }

        const requestedSessionId = normalizeOptionalString(sessionReq.session_id);
        const sessionId = requestedSessionId ?? nextSessionId(this.store);
        if (this.store.state.liquidity_simulation_sessions[sessionId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'simulation session already exists', {
              reason_code: 'liquidity_simulation_invalid',
              session_id: sessionId
            })
          };
        }

        const session = {
          session_id: sessionId,
          owner_actor: { type: actor.type, id: actor.id },
          simulation: true,
          simulation_session_id: sessionId,
          mode: SESSION_MODE,
          label,
          seed: normalizeOptionalString(sessionReq.seed),
          status: 'active',
          started_at: startedAt,
          updated_at: startedAt,
          stopped_at: null,
          intents: {},
          cycles: [],
          receipts: [],
          counters: {
            sync_calls: 0,
            intents_synced_total: 0,
            cycles_generated_total: 0,
            receipts_generated_total: 0
          }
        };

        this.store.state.liquidity_simulation_sessions[sessionId] = session;
        this.store.state.liquidity_simulation_events.push({
          type: 'liquidity.simulation_session.started',
          session_id: sessionId,
          occurred_at: startedAt,
          payload: {
            session_id: sessionId,
            owner_actor: { type: actor.type, id: actor.id },
            label,
            started_at: startedAt
          }
        });

        return {
          ok: true,
          body: {
            correlation_id: corr,
            session: sessionView(session)
          }
        };
      }
    });
  }

  getSession({ actor, auth, sessionId }) {
    const op = 'liquiditySimulation.session.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolved = this._resolveSessionForActor({ actor, sessionId, correlationId: corr });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    return {
      ok: true,
      body: {
        correlation_id: corr,
        session: sessionView(resolved.session)
      }
    };
  }

  stopSession({ actor, auth, sessionId, idempotencyKey, request }) {
    const op = 'liquiditySimulation.session.stop';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { session_id: sessionId, request },
      correlationId: corr,
      handler: () => {
        const resolved = this._resolveSessionForActor({ actor, sessionId, correlationId: corr });
        if (!resolved.ok) return { ok: false, body: resolved.body };

        const stoppedAt = normalizeOptionalString(request?.stopped_at) ?? this._nowIso(auth);
        if (parseIsoMs(stoppedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation stop timestamp', {
              reason_code: 'liquidity_simulation_payload_invalid',
              stopped_at: request?.stopped_at ?? null
            })
          };
        }

        if (resolved.session.status !== 'stopped') {
          resolved.session.status = 'stopped';
          resolved.session.stopped_at = stoppedAt;
          resolved.session.updated_at = stoppedAt;
          this.store.state.liquidity_simulation_events.push({
            type: 'liquidity.simulation_session.stopped',
            session_id: resolved.session.session_id,
            occurred_at: stoppedAt,
            payload: {
              session_id: resolved.session.session_id,
              stopped_at: stoppedAt
            }
          });
        }

        return {
          ok: true,
          body: {
            correlation_id: corr,
            session: sessionView(resolved.session)
          }
        };
      }
    });
  }

  syncIntents({ actor, auth, sessionId, idempotencyKey, request }) {
    const op = 'liquiditySimulation.intent.sync';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { session_id: sessionId, request },
      correlationId: corr,
      handler: () => {
        const resolved = this._resolveSessionForActor({ actor, sessionId, correlationId: corr });
        if (!resolved.ok) return { ok: false, body: resolved.body };

        if (resolved.session.status !== 'active') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'simulation session is not active', {
              reason_code: 'liquidity_simulation_session_inactive',
              session_id: resolved.session.session_id,
              status: resolved.session.status
            })
          };
        }

        const sync = request?.sync;
        if (!sync || typeof sync !== 'object' || Array.isArray(sync)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation sync payload', {
              reason_code: 'liquidity_simulation_payload_invalid'
            })
          };
        }

        const intents = Array.isArray(sync.intents) ? sync.intents : null;
        if (!intents || intents.length < 1) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'simulation sync intents are required', {
              reason_code: 'liquidity_simulation_payload_invalid'
            })
          };
        }

        const syncedAt = normalizeOptionalString(sync.synced_at) ?? this._nowIso(auth);
        if (parseIsoMs(syncedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation sync timestamp', {
              reason_code: 'liquidity_simulation_payload_invalid',
              synced_at: sync.synced_at ?? null
            })
          };
        }

        const normalizedIntents = [];
        for (const intent of intents) {
          const intentId = normalizeOptionalString(intent?.intent_id);
          const intentActor = normalizeActor(intent?.actor);
          const valueUsd = Number(intent?.value_usd);
          const status = normalizeOptionalString(intent?.status) ?? 'active';

          if (!intentId || !intentActor || !Number.isFinite(valueUsd) || valueUsd < 0 || !INTENT_STATUSES.has(status)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation intent payload', {
                reason_code: 'liquidity_simulation_payload_invalid'
              })
            };
          }

          normalizedIntents.push({
            intent_id: intentId,
            actor: intentActor,
            value_usd: Math.round((valueUsd + Number.EPSILON) * 100) / 100,
            status,
            liquidity_provider_ref: intent?.liquidity_provider_ref && typeof intent.liquidity_provider_ref === 'object' && !Array.isArray(intent.liquidity_provider_ref)
              ? clone(intent.liquidity_provider_ref)
              : undefined,
            persona_ref: intent?.persona_ref && typeof intent.persona_ref === 'object' && !Array.isArray(intent.persona_ref)
              ? clone(intent.persona_ref)
              : undefined,
            liquidity_policy_ref: intent?.liquidity_policy_ref && typeof intent.liquidity_policy_ref === 'object' && !Array.isArray(intent.liquidity_policy_ref)
              ? clone(intent.liquidity_policy_ref)
              : undefined
          });
        }

        for (const normalized of normalizedIntents) {
          resolved.session.intents[normalized.intent_id] = normalizeIntentRecord(normalized, syncedAt);
        }

        resolved.session.counters.sync_calls += 1;
        resolved.session.counters.intents_synced_total += normalizedIntents.length;
        resolved.session.updated_at = syncedAt;

        const activeIntents = Object.values(resolved.session.intents)
          .filter(intent => intent.status === 'active')
          .sort((a, b) => String(a.intent_id).localeCompare(String(b.intent_id)));

        let generatedCycleId = null;
        let generatedReceiptId = null;

        if (activeIntents.length >= 2) {
          const cycleSequence = resolved.session.counters.cycles_generated_total + 1;
          const cycleId = `sim_cycle_${resolved.session.session_id}_${String(cycleSequence).padStart(4, '0')}`;
          const participants = activeIntents.slice(0, 2).map(intent => ({
            intent_id: intent.intent_id,
            actor: clone(intent.actor),
            liquidity_provider_ref: intent.liquidity_provider_ref ? clone(intent.liquidity_provider_ref) : undefined,
            persona_ref: intent.persona_ref ? clone(intent.persona_ref) : undefined,
            liquidity_policy_ref: intent.liquidity_policy_ref ? clone(intent.liquidity_policy_ref) : undefined
          }));

          const cycle = {
            cycle_id: cycleId,
            simulation: true,
            simulation_session_id: resolved.session.session_id,
            completed_at: syncedAt,
            confidence_score: 0.75,
            participants
          };

          const receiptSequence = resolved.session.counters.receipts_generated_total + 1;
          const receiptId = `sim_receipt_${resolved.session.session_id}_${String(receiptSequence).padStart(4, '0')}`;
          const receipt = {
            receipt_id: receiptId,
            cycle_id: cycleId,
            simulation: true,
            simulation_session_id: resolved.session.session_id,
            final_state: 'completed',
            created_at: syncedAt,
            intent_ids: participants.map(participant => participant.intent_id).sort(),
            liquidity_provider_summary: normalizeLiquidityProviderSummary(participants)
          };

          resolved.session.cycles.push(cycle);
          resolved.session.receipts.push(receipt);
          resolved.session.counters.cycles_generated_total += 1;
          resolved.session.counters.receipts_generated_total += 1;

          generatedCycleId = cycleId;
          generatedReceiptId = receiptId;

          this.store.state.liquidity_simulation_events.push({
            type: 'liquidity.simulation_cycle.completed',
            session_id: resolved.session.session_id,
            occurred_at: syncedAt,
            payload: {
              session_id: resolved.session.session_id,
              cycle_id: cycleId,
              receipt_id: receiptId,
              completed_at: syncedAt
            }
          });
        }

        return {
          ok: true,
          body: {
            correlation_id: corr,
            session_id: resolved.session.session_id,
            simulation: true,
            simulation_session_id: resolved.session.session_id,
            synced_intents_count: normalizedIntents.length,
            active_intents_count: activeIntents.length,
            generated_cycle_id: generatedCycleId,
            generated_receipt_id: generatedReceiptId,
            session: sessionView(resolved.session)
          }
        };
      }
    });
  }

  exportCycles({ actor, auth, sessionId, query }) {
    const op = 'liquiditySimulation.cycle.export';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolved = this._resolveSessionForActor({ actor, sessionId, correlationId: corr });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const parsedQuery = parseExportQuery(query);
    if (!parsedQuery.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation export query', {
          reason_code: parsedQuery.reason_code,
          ...parsedQuery.details
        })
      };
    }

    const entries = (resolved.session.cycles ?? []).map(normalizeCycleEntry);
    entries.sort((a, b) => String(a.cycle_id).localeCompare(String(b.cycle_id)));

    let start = 0;
    if (parsedQuery.cursor_after) {
      const idx = entries.findIndex(entry => entry.cycle_id === parsedQuery.cursor_after);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation export query', {
            reason_code: 'liquidity_simulation_export_query_invalid',
            cursor_after: parsedQuery.cursor_after
          })
        };
      }
      start = idx + 1;
    }

    const page = entries.slice(start, start + parsedQuery.limit);
    const hasMore = start + page.length < entries.length;
    const nextCursor = hasMore ? page[page.length - 1]?.cycle_id ?? null : null;

    const signedExport = buildSignedPolicyAuditExportPayload({
      exportedAt: this._nowIso(auth),
      query: {
        session_id: resolved.session.session_id,
        limit: parsedQuery.limit,
        ...(parsedQuery.cursor_after ? { cursor_after: parsedQuery.cursor_after } : {})
      },
      entries: page,
      totalFiltered: entries.length,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        session_id: resolved.session.session_id,
        simulation: true,
        simulation_session_id: resolved.session.session_id,
        export: signedExport
      }
    };
  }

  exportReceipts({ actor, auth, sessionId, query }) {
    const op = 'liquiditySimulation.receipt.export';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolved = this._resolveSessionForActor({ actor, sessionId, correlationId: corr });
    if (!resolved.ok) return { ok: false, body: resolved.body };

    const parsedQuery = parseExportQuery(query);
    if (!parsedQuery.ok) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation export query', {
          reason_code: parsedQuery.reason_code,
          ...parsedQuery.details
        })
      };
    }

    const entries = (resolved.session.receipts ?? []).map(normalizeReceiptEntry);
    entries.sort((a, b) => String(a.receipt_id).localeCompare(String(b.receipt_id)));

    let start = 0;
    if (parsedQuery.cursor_after) {
      const idx = entries.findIndex(entry => entry.receipt_id === parsedQuery.cursor_after);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid simulation export query', {
            reason_code: 'liquidity_simulation_export_query_invalid',
            cursor_after: parsedQuery.cursor_after
          })
        };
      }
      start = idx + 1;
    }

    const page = entries.slice(start, start + parsedQuery.limit);
    const hasMore = start + page.length < entries.length;
    const nextCursor = hasMore ? page[page.length - 1]?.receipt_id ?? null : null;

    const signedExport = buildSignedPolicyAuditExportPayload({
      exportedAt: this._nowIso(auth),
      query: {
        session_id: resolved.session.session_id,
        limit: parsedQuery.limit,
        ...(parsedQuery.cursor_after ? { cursor_after: parsedQuery.cursor_after } : {})
      },
      entries: page,
      totalFiltered: entries.length,
      nextCursor,
      withAttestation: true,
      withCheckpoint: true
    });

    return {
      ok: true,
      body: {
        correlation_id: corr,
        session_id: resolved.session.session_id,
        simulation: true,
        simulation_session_id: resolved.session.session_id,
        export: signedExport
      }
    };
  }
}
