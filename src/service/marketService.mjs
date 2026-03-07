import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { effectiveActorForDelegation } from '../core/tradingPolicyBoundaries.mjs';

const LISTING_KINDS = new Set(['post', 'want', 'capability']);
const LISTING_STATUS = new Set(['open', 'paused', 'closed', 'suspended']);
const EDGE_TYPES = new Set(['interest', 'offer', 'counter', 'block']);
const EDGE_STATUS = new Set(['open', 'accepted', 'declined', 'withdrawn', 'expired']);
const THREAD_STATUS = new Set(['active', 'closed']);
const MESSAGE_TYPES = new Set(['text', 'terms_patch', 'system']);
const REF_KINDS = new Set(['listing']);
const ANCHOR_KINDS = new Set(['listing', 'edge', 'deal']);
const DEFAULT_MARKET_SIGNUP_SCOPES = Object.freeze([
  'market:read',
  'market:write',
  'receipts:read',
  'payment_proofs:write',
  'execution_grants:write'
]);

function correlationId(op) {
  return `corr_${String(op).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeOptionalObject(value) {
  return isPlainObject(value) ? clone(value) : null;
}

function parseIsoMs(iso) {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseLimit(value, fallback = 25) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 100);
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
  store.state.market_listings ||= {};
  store.state.market_listing_counter ||= 0;
  store.state.market_edges ||= {};
  store.state.market_edge_counter ||= 0;
  store.state.market_threads ||= {};
  store.state.market_thread_counter ||= 0;
  store.state.market_messages ||= {};
  store.state.market_message_counter ||= 0;
  store.state.market_deals ||= {};
  store.state.market_deal_counter ||= 0;
  store.state.market_payment_proofs ||= {};
  store.state.market_payment_proof_counter ||= 0;
  store.state.market_execution_grants ||= {};
  store.state.market_execution_grant_counter ||= 0;
  store.state.market_feed_events ||= {};
  store.state.market_feed_event_counter ||= 0;
  store.state.market_actor_profiles ||= {};
  store.state.market_actor_profile_counter ||= 0;
  store.state.market_actor_quotas ||= {};
  store.state.market_moderation_queue ||= {};
}

function nextListingId(store) {
  store.state.market_listing_counter = Number(store.state.market_listing_counter ?? 0) + 1;
  const n = String(store.state.market_listing_counter).padStart(6, '0');
  return `listing_${n}`;
}

function nextEdgeId(store) {
  store.state.market_edge_counter = Number(store.state.market_edge_counter ?? 0) + 1;
  const n = String(store.state.market_edge_counter).padStart(6, '0');
  return `edge_${n}`;
}

function nextThreadId(store) {
  store.state.market_thread_counter = Number(store.state.market_thread_counter ?? 0) + 1;
  const n = String(store.state.market_thread_counter).padStart(6, '0');
  return `thread_${n}`;
}

function nextMessageId(store) {
  store.state.market_message_counter = Number(store.state.market_message_counter ?? 0) + 1;
  const n = String(store.state.market_message_counter).padStart(6, '0');
  return `message_${n}`;
}

function nextActorProfileCounter(store) {
  store.state.market_actor_profile_counter = Number(store.state.market_actor_profile_counter ?? 0) + 1;
  return store.state.market_actor_profile_counter;
}

function actorEquals(a, b) {
  return (a?.type ?? null) === (b?.type ?? null) && (a?.id ?? null) === (b?.id ?? null);
}

function listingOwnsActor(listing, actor) {
  return actorEquals(listing?.owner_actor ?? null, actor ?? null);
}

function resolveSubjectActor({ actor, auth }) {
  return effectiveActorForDelegation({ actor, auth }) ?? actor;
}

function slugifyLabel(value, fallback = 'owner') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function actorProfileKey(actor) {
  if (!actor?.type || !actor?.id) return null;
  return `${actor.type}:${actor.id}`;
}

function openSignupEnabled() {
  const mode = normalizeOptionalString(process.env.MARKET_OPEN_SIGNUP_MODE)?.toLowerCase() ?? 'open';
  return !new Set(['off', 'closed', 'invite']).has(mode);
}

function normalizeActorProfileView(record) {
  if (!record) return null;
  return {
    actor: clone(record.actor),
    display_name: record.display_name,
    handle: record.handle,
    owner_mode: record.owner_mode,
    default_workspace_id: record.default_workspace_id,
    bio: record.bio ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function actorProfileSummary(store, actor) {
  const key = actorProfileKey(actor);
  if (!key) return null;
  return normalizeActorProfileView(store.state.market_actor_profiles?.[key] ?? null);
}

function isPublicViewer(actor) {
  return !actor?.type || !actor?.id;
}

function listingIsPublicVisible(listing) {
  return !!listing && listing.status !== 'suspended';
}

function edgeIsPublicVisible(store, edge) {
  if (!edge) return false;
  const source = store.state.market_listings?.[edge.source_ref?.id] ?? null;
  const target = store.state.market_listings?.[edge.target_ref?.id] ?? null;
  return listingIsPublicVisible(source) && listingIsPublicVisible(target);
}

function dealIsPublicVisible(store, deal) {
  if (!deal) return false;
  const edge = store.state.market_edges?.[deal.origin_edge_id] ?? null;
  return edgeIsPublicVisible(store, edge);
}

function normalizeListingView(record, store) {
  return {
    listing_id: record.listing_id,
    workspace_id: record.workspace_id,
    owner_actor: clone(record.owner_actor),
    owner_profile: actorProfileSummary(store, record.owner_actor),
    kind: record.kind,
    status: record.status,
    title: record.title,
    description: record.description ?? null,
    offer: clone(record.offer ?? []),
    want_spec: record.want_spec ? clone(record.want_spec) : null,
    budget: record.budget ? clone(record.budget) : null,
    constraints: record.constraints ? clone(record.constraints) : null,
    capability_profile: record.capability_profile ? clone(record.capability_profile) : null,
    expires_at: record.expires_at ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function normalizeEdgeView(record) {
  return {
    edge_id: record.edge_id,
    workspace_id: record.workspace_id,
    source_ref: clone(record.source_ref),
    target_ref: clone(record.target_ref),
    edge_type: record.edge_type,
    status: record.status,
    terms_patch: record.terms_patch ? clone(record.terms_patch) : null,
    note: record.note ?? null,
    expires_at: record.expires_at ?? null,
    created_by: clone(record.created_by),
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function normalizeThreadView(record) {
  return {
    thread_id: record.thread_id,
    workspace_id: record.workspace_id,
    participants: clone(record.participants),
    status: record.status,
    anchor_ref: record.anchor_ref ? clone(record.anchor_ref) : null,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
}

function normalizeMessageView(record) {
  return {
    message_id: record.message_id,
    thread_id: record.thread_id,
    sender_actor: clone(record.sender_actor),
    message_type: record.message_type,
    payload: clone(record.payload),
    created_at: record.created_at
  };
}

function signupIdempotencyScopeKey(operationId, idempotencyKey) {
  return `public|${operationId}|${idempotencyKey}`;
}

function sortByUpdatedDescThenId(rows, idField) {
  rows.sort((a, b) => {
    const at = parseIsoMs(a.updated_at) ?? 0;
    const bt = parseIsoMs(b.updated_at) ?? 0;
    if (bt !== at) return bt - at;
    const aid = String(a[idField] ?? '');
    const bid = String(b[idField] ?? '');
    return aid.localeCompare(bid);
  });
}

function encodeCursor(parts) {
  return parts.join('|');
}

function decodeCursor(raw, expectedParts) {
  const v = normalizeOptionalString(raw);
  if (!v) return null;
  const parts = v.split('|');
  if (parts.length !== expectedParts) return undefined;
  if (parts.some(x => !x)) return undefined;
  return parts;
}

function buildPaginationSlice({ rows, limit, cursorAfter, keyFn, cursorParts }) {
  let start = 0;

  if (cursorAfter) {
    const decoded = decodeCursor(cursorAfter, cursorParts);
    if (decoded === undefined) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid cursor format',
        details: { reason_code: 'market_feed_query_invalid', cursor_after: cursorAfter }
      };
    }

    if (decoded) {
      const idx = rows.findIndex(row => {
        const key = keyFn(row);
        return key.length === decoded.length && key.every((v, i) => String(v) === String(decoded[i]));
      });

      if (idx < 0) {
        return {
          ok: false,
          code: 'CONSTRAINT_VIOLATION',
          message: 'cursor not found',
          details: { reason_code: 'market_cursor_not_found', cursor_after: cursorAfter }
        };
      }

      start = idx + 1;
    }
  }

  const page = rows.slice(start, start + limit);
  const hasMore = start + limit < rows.length;
  const nextCursor = hasMore && page.length > 0 ? encodeCursor(keyFn(page[page.length - 1])) : null;

  return {
    ok: true,
    value: {
      page,
      nextCursor,
      total: rows.length
    }
  };
}

function validateOfferArray(offer) {
  if (!Array.isArray(offer) || offer.length < 1) return false;
  return offer.every(item => !!item && typeof item === 'object' && !Array.isArray(item));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRecordedAt(request, auth) {
  return normalizeOptionalString(request?.recorded_at) ?? normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString();
}

function normalizeListingKind(value) {
  return normalizeOptionalString(value)?.toLowerCase() ?? null;
}

function normalizeListingStatus(value, fallback = 'open') {
  return normalizeOptionalString(value)?.toLowerCase() ?? fallback;
}

function normalizeEdgeType(value) {
  return normalizeOptionalString(value)?.toLowerCase() ?? null;
}

function normalizeEdgeStatus(value, fallback = 'open') {
  return normalizeOptionalString(value)?.toLowerCase() ?? fallback;
}

function normalizeRef(value) {
  if (!isPlainObject(value)) return null;
  const kind = normalizeOptionalString(value.kind)?.toLowerCase() ?? null;
  const id = normalizeOptionalString(value.id);
  if (!kind || !id || !REF_KINDS.has(kind)) return null;
  return { kind, id };
}

function normalizeAnchorRef(value) {
  if (!isPlainObject(value)) return null;
  const kind = normalizeOptionalString(value.kind)?.toLowerCase() ?? null;
  const id = normalizeOptionalString(value.id);
  if (!kind || !id || !ANCHOR_KINDS.has(kind)) return null;
  return { kind, id };
}

function normalizeActorRef(value) {
  if (!isPlainObject(value)) return null;
  const type = normalizeOptionalString(value.type);
  const id = normalizeOptionalString(value.id);
  if (!type || !id) return null;
  return { type, id };
}

function normalizeParticipants(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const out = [];
  const seen = new Set();
  for (const actor of value) {
    const normalized = normalizeActorRef(actor);
    if (!normalized) return null;
    const key = `${normalized.type}:${normalized.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  if (out.length < 2) return null;
  out.sort((a, b) => {
    const t = String(a.type).localeCompare(String(b.type));
    if (t !== 0) return t;
    return String(a.id).localeCompare(String(b.id));
  });
  return out;
}

function includesActor(participants, actor) {
  return Array.isArray(participants) && participants.some(p => actorEquals(p, actor));
}

function normalizeActionRequest(request, auth) {
  const recordedAt = normalizeRecordedAt(request, auth);
  if (parseIsoMs(recordedAt) === null) return { ok: false, recordedAt: null };
  return { ok: true, recordedAt };
}

function normalizeListQuery(query) {
  const allowed = new Set(['workspace_id', 'owner_actor_type', 'owner_actor_id', 'kind', 'status', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const ownerActorType = normalizeOptionalString(query?.owner_actor_type);
  const ownerActorId = normalizeOptionalString(query?.owner_actor_id);
  const kind = normalizeListingKind(query?.kind);
  const status = normalizeListingStatus(query?.status, null);
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (kind && !LISTING_KINDS.has(kind)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid listing kind filter',
      details: { reason_code: 'market_listing_kind_invalid', kind }
    };
  }

  if (status && !LISTING_STATUS.has(status)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid listing status filter',
      details: { reason_code: 'market_listing_status_invalid', status }
    };
  }

  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }

  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      owner_actor_type: ownerActorType,
      owner_actor_id: ownerActorId,
      kind,
      status,
      limit,
      cursor_after: cursorAfter
    }
  };
}

function normalizeEdgeListQuery(query) {
  const allowed = new Set(['workspace_id', 'source_id', 'target_id', 'status', 'edge_type', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const sourceId = normalizeOptionalString(query?.source_id);
  const targetId = normalizeOptionalString(query?.target_id);
  const status = normalizeEdgeStatus(query?.status, null);
  const edgeType = normalizeEdgeType(query?.edge_type);
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (status && !EDGE_STATUS.has(status)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid edge status filter',
      details: { reason_code: 'market_edge_status_transition_invalid', status }
    };
  }

  if (edgeType && !EDGE_TYPES.has(edgeType)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid edge type filter',
      details: { reason_code: 'market_edge_invalid', edge_type: edgeType }
    };
  }

  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }

  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      source_id: sourceId,
      target_id: targetId,
      status,
      edge_type: edgeType,
      limit,
      cursor_after: cursorAfter
    }
  };
}

function normalizeFeedQuery(query) {
  const allowed = new Set(['workspace_id', 'item_type', 'types', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const itemType = normalizeOptionalString(query?.item_type)?.toLowerCase() ?? null;
  const types = Array.from(new Set(String(query?.types ?? '')
    .split(',')
    .map(v => normalizeOptionalString(v)?.toLowerCase())
    .filter(Boolean)));
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  const validItemTypes = new Set(['listing', 'edge', 'deal']);
  if (itemType && !validItemTypes.has(itemType)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid item_type',
      details: { reason_code: 'market_feed_query_invalid', item_type: itemType }
    };
  }

  if (types.some(type => !validItemTypes.has(type))) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid types filter',
      details: { reason_code: 'market_feed_query_invalid', types }
    };
  }

  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }

  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      item_type: itemType,
      types,
      limit,
      cursor_after: cursorAfter
    }
  };
}

function normalizeThreadListQuery(query) {
  const allowed = new Set(['workspace_id', 'status', 'participant_type', 'participant_id', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const workspaceId = normalizeOptionalString(query?.workspace_id);
  const status = normalizeOptionalString(query?.status)?.toLowerCase() ?? null;
  const participantType = normalizeOptionalString(query?.participant_type);
  const participantId = normalizeOptionalString(query?.participant_id);
  const limit = parseLimit(query?.limit, 25);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (status && !THREAD_STATUS.has(status)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid thread status filter',
      details: { reason_code: 'market_thread_invalid', status }
    };
  }

  if ((participantType && !participantId) || (!participantType && participantId)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'participant_type and participant_id must be provided together',
      details: { reason_code: 'market_feed_query_invalid' }
    };
  }

  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }

  return {
    ok: true,
    value: {
      workspace_id: workspaceId,
      status,
      participant_type: participantType,
      participant_id: participantId,
      limit,
      cursor_after: cursorAfter
    }
  };
}

function normalizeMessageListQuery(query) {
  const allowed = new Set(['message_type', 'limit', 'cursor_after']);
  for (const key of Object.keys(query ?? {})) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid query parameter',
        details: { reason_code: 'market_feed_query_invalid', key }
      };
    }
  }

  const messageType = normalizeOptionalString(query?.message_type)?.toLowerCase() ?? null;
  const limit = parseLimit(query?.limit, 50);
  const cursorAfter = normalizeOptionalString(query?.cursor_after);

  if (messageType && !MESSAGE_TYPES.has(messageType)) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid message_type filter',
      details: { reason_code: 'market_message_invalid', message_type: messageType }
    };
  }

  if (limit === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid limit',
      details: { reason_code: 'market_feed_query_invalid', limit: query?.limit }
    };
  }

  return {
    ok: true,
    value: {
      message_type: messageType,
      limit,
      cursor_after: cursorAfter
    }
  };
}

export class MarketService {
  /**
   * @param {{ store: import('../store/jsonStateStore.mjs').JsonStateStore }} opts
   */
  constructor({ store }) {
    if (!store) throw new Error('store is required');
    this.store = store;
    ensureState(this.store);
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

  _withIdempotency({ actor, operationId, idempotencyKey, requestBody, correlationId: corr, handler }) {
    const scopeKey = idempotencyScopeKey({ actor, operationId, idempotencyKey });
    const requestHash = payloadHash(requestBody);
    const existing = this.store.state.idempotency[scopeKey];

    if (existing) {
      if (existing.payload_hash === requestHash) {
        return {
          replayed: true,
          result: clone(existing.result)
        };
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

  _normalizeListingCreate({ request, actor, auth, correlationId: corr }) {
    const listing = request?.listing;
    if (!isPlainObject(listing)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid market listing payload', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    const recordedAt = normalizeRecordedAt(request, auth);
    if (parseIsoMs(recordedAt) === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing timestamp', {
          reason_code: 'market_listing_invalid',
          recorded_at: request?.recorded_at ?? null
        })
      };
    }

    const workspaceId = normalizeOptionalString(listing.workspace_id);
    const title = normalizeOptionalString(listing.title);
    const kind = normalizeListingKind(listing.kind);
    const status = normalizeListingStatus(listing.status, 'open');

    if (!workspaceId || !title) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'missing required listing fields', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    if (!kind || !LISTING_KINDS.has(kind)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing kind', {
          reason_code: 'market_listing_kind_invalid',
          kind
        })
      };
    }

    if (!LISTING_STATUS.has(status) || status === 'closed' || status === 'suspended') {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing status', {
          reason_code: 'market_listing_status_invalid',
          status
        })
      };
    }

    const subjectActor = resolveSubjectActor({ actor, auth });
    const ownerActor = listing.owner_actor ?? subjectActor;
    if (!ownerActor || !normalizeOptionalString(ownerActor.type) || !normalizeOptionalString(ownerActor.id)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing owner actor', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    if (!actorEquals(ownerActor, subjectActor)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'listing owner actor must match caller', {
          reason_code: 'market_listing_forbidden',
          actor: subjectActor,
          owner_actor: ownerActor
        })
      };
    }

    const offer = listing.offer ?? [];
    if (kind === 'post' && !validateOfferArray(offer)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'post listings require non-empty offer', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    if (kind === 'want' && Array.isArray(offer) && offer.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'want listings must not provide offer', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    const capabilityProfile = listing.capability_profile ?? null;
    if (kind === 'capability') {
      const deliverableSchema = capabilityProfile?.deliverable_schema;
      const rateCard = capabilityProfile?.rate_card;
      if (!isPlainObject(capabilityProfile) || !isPlainObject(deliverableSchema) || !isPlainObject(rateCard)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'capability listings require capability profile', {
            reason_code: 'market_listing_invalid'
          })
        };
      }
    }

    if (kind !== 'capability' && capabilityProfile !== null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'capability_profile is only valid for capability listings', {
          reason_code: 'market_listing_invalid'
        })
      };
    }

    const description = normalizeOptionalString(listing.description);
    const wantSpec = listing.want_spec === null ? null : normalizeOptionalObject(listing.want_spec);
    const budget = listing.budget === null ? null : normalizeOptionalObject(listing.budget);
    const constraints = listing.constraints === null ? null : normalizeOptionalObject(listing.constraints);
    const expiresAt = normalizeOptionalString(listing.expires_at);
    if (expiresAt && parseIsoMs(expiresAt) === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing expiry timestamp', {
          reason_code: 'market_listing_invalid',
          expires_at: listing.expires_at
        })
      };
    }

    const requestedId = normalizeOptionalString(listing.listing_id);

    return {
      ok: true,
      value: {
        listing_id: requestedId,
        workspace_id: workspaceId,
        owner_actor: { type: ownerActor.type, id: ownerActor.id },
        kind,
        status,
        title,
        description,
        offer: clone(Array.isArray(offer) ? offer : []),
        want_spec: wantSpec,
        budget,
        constraints,
        capability_profile: capabilityProfile ? clone(capabilityProfile) : null,
        expires_at: expiresAt,
        recorded_at: recordedAt
      }
    };
  }

  signup({ actor, auth, idempotencyKey, request }) {
    const op = 'marketSignup.create';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const scopeKey = signupIdempotencyScopeKey(op, idempotencyKey);
    const requestHash = payloadHash(request);
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
            operation_id: op,
            idempotency_key: idempotencyKey
          })
        }
      };
    }

    const result = (() => {
      if (!openSignupEnabled()) {
        return {
          ok: false,
          body: errorResponse(corr, 'FORBIDDEN', 'market signup is not open', {
            reason_code: 'market_signup_closed'
          })
        };
      }

      const displayName = normalizeOptionalString(request?.display_name);
      const bio = normalizeOptionalString(request?.bio);
      const ownerMode = normalizeOptionalString(request?.owner_mode)?.toLowerCase() ?? 'agent_owner';
      const requestedWorkspaceId = normalizeOptionalString(request?.workspace_id);
      const recordedAt = normalizeRecordedAt(request, auth);

      if (!displayName || parseIsoMs(recordedAt) === null) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid signup payload', {
            reason_code: 'market_signup_invalid'
          })
        };
      }

      if (!new Set(['agent_owner', 'operator', 'builder']).has(ownerMode)) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid owner mode', {
            reason_code: 'market_signup_invalid',
            owner_mode: ownerMode
          })
        };
      }

      const counter = nextActorProfileCounter(this.store);
      const slug = slugifyLabel(displayName);
      const actorRef = { type: 'user', id: `owner_${slug}_${String(counter).padStart(4, '0')}` };
      const workspaceId = requestedWorkspaceId ?? 'open_market';
      const profile = {
        actor: actorRef,
        display_name: displayName,
        handle: slug,
        owner_mode: ownerMode,
        default_workspace_id: workspaceId,
        bio,
        created_at: recordedAt,
        updated_at: recordedAt
      };

      this.store.state.market_actor_profiles[actorProfileKey(actorRef)] = profile;
      this.store.state.market_actor_quotas[actorProfileKey(actorRef)] ||= {
        actor: clone(actorRef),
        trust_tier: 'open_signup',
        credits_available: 1000,
        listings_created: 0,
        edges_created: 0,
        created_at: recordedAt,
        updated_at: recordedAt
      };

      return {
        ok: true,
        body: {
          correlation_id: corr,
          actor: clone(actorRef),
          owner_profile: normalizeActorProfileView(profile),
          auth_hints: {
            scopes: clone(DEFAULT_MARKET_SIGNUP_SCOPES)
          }
        }
      };
    })();

    this.store.state.idempotency[scopeKey] = {
      payload_hash: requestHash,
      result: clone(result)
    };
    return { replayed: false, result };
  }

  getStats({ actor, auth }) {
    const op = 'marketStats.get';
    const corr = correlationId(op);
    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const visibleListings = Object.values(this.store.state.market_listings ?? {}).filter(listingIsPublicVisible);
    const visibleEdges = Object.values(this.store.state.market_edges ?? {}).filter(edge => edgeIsPublicVisible(this.store, edge));
    const visibleDeals = Object.values(this.store.state.market_deals ?? {}).filter(deal => dealIsPublicVisible(this.store, deal));
    const actorKeys = new Set();
    const workspaces = new Set();
    let latestActivityAt = null;

    for (const listing of visibleListings) {
      workspaces.add(listing.workspace_id);
      const key = actorProfileKey(listing.owner_actor);
      if (key) actorKeys.add(key);
      if (!latestActivityAt || (parseIsoMs(listing.updated_at) ?? 0) > (parseIsoMs(latestActivityAt) ?? 0)) latestActivityAt = listing.updated_at;
    }
    for (const edge of visibleEdges) {
      workspaces.add(edge.workspace_id);
      if (!latestActivityAt || (parseIsoMs(edge.updated_at) ?? 0) > (parseIsoMs(latestActivityAt) ?? 0)) latestActivityAt = edge.updated_at;
    }
    for (const deal of visibleDeals) {
      workspaces.add(deal.workspace_id);
      for (const participant of deal.participants ?? []) {
        const key = actorProfileKey(participant);
        if (key) actorKeys.add(key);
      }
      if (!latestActivityAt || (parseIsoMs(deal.updated_at) ?? 0) > (parseIsoMs(latestActivityAt) ?? 0)) latestActivityAt = deal.updated_at;
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        stats: {
          actors: actorKeys.size,
          workspaces: workspaces.size,
          listings_open: visibleListings.filter(row => row.status === 'open').length,
          wants_open: visibleListings.filter(row => row.kind === 'want' && row.status === 'open').length,
          capabilities_open: visibleListings.filter(row => row.kind === 'capability' && row.status === 'open').length,
          edges_open: visibleEdges.filter(row => row.status === 'open').length,
          deals_active: visibleDeals.filter(row => row.status !== 'completed' && row.status !== 'failed' && row.status !== 'cancelled').length,
          deals_completed: visibleDeals.filter(row => row.status === 'completed').length,
          latest_activity_at: latestActivityAt
        }
      }
    };
  }

  createListing({ actor, auth, idempotencyKey, request }) {
    const op = 'marketListings.create';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const normalized = this._normalizeListingCreate({ request, actor, auth, correlationId: corr });
        if (!normalized.ok) return { ok: false, body: normalized.body };

        const listingId = normalized.value.listing_id ?? nextListingId(this.store);
        if (this.store.state.market_listings[listingId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'listing already exists', {
              reason_code: 'market_listing_invalid',
              listing_id: listingId
            })
          };
        }

        const record = {
          listing_id: listingId,
          workspace_id: normalized.value.workspace_id,
          owner_actor: normalized.value.owner_actor,
          kind: normalized.value.kind,
          status: normalized.value.status,
          title: normalized.value.title,
          description: normalized.value.description,
          offer: normalized.value.offer,
          want_spec: normalized.value.want_spec,
          budget: normalized.value.budget,
          constraints: normalized.value.constraints,
          capability_profile: normalized.value.capability_profile,
          expires_at: normalized.value.expires_at,
          created_at: normalized.value.recorded_at,
          updated_at: normalized.value.recorded_at
        };

        this.store.state.market_listings[listingId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            listing: normalizeListingView(record, this.store)
          }
        };
      }
    });
  }

  _loadListingOrError({ listingId, correlationId: corr }) {
    const record = this.store.state.market_listings?.[listingId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'listing not found', {
          reason_code: 'market_listing_not_found',
          listing_id: listingId
        })
      };
    }
    return { ok: true, record };
  }

  patchListing({ actor, auth, listingId, idempotencyKey, request }) {
    const op = 'marketListings.patch';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadListingOrError({ listingId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const record = load.record;
        const subjectActor = resolveSubjectActor({ actor, auth });
        if (!listingOwnsActor(record, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'listing owner actor required', {
              reason_code: 'market_listing_forbidden',
              listing_id: listingId,
              actor: subjectActor,
              owner_actor: record.owner_actor
            })
          };
        }

        if (record.status === 'closed' || record.status === 'suspended') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'listing status does not allow patch', {
              reason_code: 'market_listing_status_invalid',
              listing_id: listingId,
              status: record.status
            })
          };
        }

        const patch = request?.patch;
        if (!isPlainObject(patch)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing patch payload', {
              reason_code: 'market_listing_invalid'
            })
          };
        }

        const allowed = new Set(['title', 'description', 'offer', 'want_spec', 'budget', 'constraints', 'capability_profile', 'expires_at']);
        for (const key of Object.keys(patch)) {
          if (!allowed.has(key)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing patch field', {
                reason_code: 'market_listing_invalid',
                key
              })
            };
          }
        }

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing timestamp', {
              reason_code: 'market_listing_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (patch.title !== undefined) {
          const title = normalizeOptionalString(patch.title);
          if (!title) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing title', {
                reason_code: 'market_listing_invalid'
              })
            };
          }
          record.title = title;
        }

        if (patch.description !== undefined) {
          record.description = normalizeOptionalString(patch.description);
        }

        if (patch.offer !== undefined) {
          if (record.kind === 'want') {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'want listings must not provide offer', {
                reason_code: 'market_listing_invalid'
              })
            };
          }

          if (!validateOfferArray(patch.offer)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing offer', {
                reason_code: 'market_listing_invalid'
              })
            };
          }

          record.offer = clone(patch.offer);
        }

        if (patch.want_spec !== undefined) {
          record.want_spec = patch.want_spec === null ? null : normalizeOptionalObject(patch.want_spec);
        }

        if (patch.budget !== undefined) {
          record.budget = patch.budget === null ? null : normalizeOptionalObject(patch.budget);
        }

        if (patch.constraints !== undefined) {
          record.constraints = patch.constraints === null ? null : normalizeOptionalObject(patch.constraints);
        }

        if (patch.capability_profile !== undefined) {
          if (record.kind !== 'capability') {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'capability_profile is only valid for capability listings', {
                reason_code: 'market_listing_invalid'
              })
            };
          }

          const capabilityProfile = patch.capability_profile;
          if (!isPlainObject(capabilityProfile)
            || !isPlainObject(capabilityProfile.deliverable_schema)
            || !isPlainObject(capabilityProfile.rate_card)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid capability profile', {
                reason_code: 'market_listing_invalid'
              })
            };
          }

          record.capability_profile = clone(capabilityProfile);
        }

        if (patch.expires_at !== undefined) {
          const expiresAt = normalizeOptionalString(patch.expires_at);
          if (expiresAt && parseIsoMs(expiresAt) === null) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing expiry timestamp', {
                reason_code: 'market_listing_invalid',
                expires_at: patch.expires_at
              })
            };
          }
          record.expires_at = expiresAt;
        }

        record.updated_at = recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            listing: normalizeListingView(record, this.store)
          }
        };
      }
    });
  }

  _transitionListingStatus({ actor, auth, listingId, idempotencyKey, request, operationId, targetStatus }) {
    const corr = correlationId(operationId);

    const authz = this._authorize({ actor, auth, operationId, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadListingOrError({ listingId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const record = load.record;
        const subjectActor = resolveSubjectActor({ actor, auth });
        if (!listingOwnsActor(record, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'listing owner actor required', {
              reason_code: 'market_listing_forbidden',
              listing_id: listingId,
              actor: subjectActor,
              owner_actor: record.owner_actor
            })
          };
        }

        const normalized = normalizeActionRequest(request, auth);
        if (!normalized.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing timestamp', {
              reason_code: 'market_listing_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (targetStatus === 'paused') {
          if (record.status === 'paused') {
            return {
              ok: true,
              body: {
                correlation_id: corr,
                listing: normalizeListingView(record, this.store)
              }
            };
          }

          if (record.status !== 'open') {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid listing status transition', {
                reason_code: 'market_listing_status_invalid',
                listing_id: listingId,
                from_status: record.status,
                to_status: 'paused'
              })
            };
          }
        }

        if (targetStatus === 'closed' && record.status === 'closed') {
          return {
            ok: true,
            body: {
              correlation_id: corr,
              listing: normalizeListingView(record, this.store)
            }
          };
        }

        record.status = targetStatus;
        record.updated_at = normalized.recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            listing: normalizeListingView(record, this.store)
          }
        };
      }
    });
  }

  pauseListing({ actor, auth, listingId, idempotencyKey, request }) {
    return this._transitionListingStatus({
      actor,
      auth,
      listingId,
      idempotencyKey,
      request,
      operationId: 'marketListings.pause',
      targetStatus: 'paused'
    });
  }

  closeListing({ actor, auth, listingId, idempotencyKey, request }) {
    return this._transitionListingStatus({
      actor,
      auth,
      listingId,
      idempotencyKey,
      request,
      operationId: 'marketListings.close',
      targetStatus: 'closed'
    });
  }

  getListing({ actor, auth, listingId }) {
    const op = 'marketListings.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadListingOrError({ listingId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };
    if (isPublicViewer(actor) && !listingIsPublicVisible(load.record)) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'listing not found', {
          reason_code: 'market_listing_not_found',
          listing_id: listingId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        listing: normalizeListingView(load.record, this.store)
      }
    };
  }

  listListings({ actor, auth, query }) {
    const op = 'marketListings.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const rows = Object.values(this.store.state.market_listings ?? {})
      .filter(row => {
        if (isPublicViewer(actor) && !listingIsPublicVisible(row)) return false;
        if (normalized.value.workspace_id && row.workspace_id !== normalized.value.workspace_id) return false;
        if (normalized.value.owner_actor_type && row.owner_actor?.type !== normalized.value.owner_actor_type) return false;
        if (normalized.value.owner_actor_id && row.owner_actor?.id !== normalized.value.owner_actor_id) return false;
        if (normalized.value.kind && row.kind !== normalized.value.kind) return false;
        if (normalized.value.status && row.status !== normalized.value.status) return false;
        return true;
      });

    sortByUpdatedDescThenId(rows, 'listing_id');

    const page = buildPaginationSlice({
      rows,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: row => [row.updated_at, row.listing_id],
      cursorParts: 2
    });

    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        listings: page.value.page.map(row => normalizeListingView(row, this.store)),
        total: page.value.total,
        next_cursor: page.value.nextCursor
      }
    };
  }

  _resolveListingByRef(ref) {
    if (ref?.kind !== 'listing') return null;
    return this.store.state.market_listings?.[ref.id] ?? null;
  }

  createEdge({ actor, auth, idempotencyKey, request }) {
    const op = 'marketEdges.create';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const edge = request?.edge;
        if (!isPlainObject(edge)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid market edge payload', {
              reason_code: 'market_edge_invalid'
            })
          };
        }

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge timestamp', {
              reason_code: 'market_edge_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const sourceRef = normalizeRef(edge.source_ref);
        const targetRef = normalizeRef(edge.target_ref);
        const edgeType = normalizeEdgeType(edge.edge_type);
        const status = normalizeEdgeStatus(edge.status, 'open');

        if (!sourceRef || !targetRef || sourceRef.id === targetRef.id || !edgeType || !EDGE_TYPES.has(edgeType) || status !== 'open') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid market edge payload', {
              reason_code: 'market_edge_invalid'
            })
          };
        }

        const sourceListing = this._resolveListingByRef(sourceRef);
        const targetListing = this._resolveListingByRef(targetRef);
        if (!sourceListing || !targetListing) {
          return {
            ok: false,
            body: errorResponse(corr, 'NOT_FOUND', 'edge reference listing not found', {
              reason_code: 'market_edge_not_found',
              source_ref: sourceRef,
              target_ref: targetRef
            })
          };
        }

        if (sourceListing.workspace_id !== targetListing.workspace_id) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge refs must share workspace', {
              reason_code: 'market_edge_invalid',
              source_workspace_id: sourceListing.workspace_id,
              target_workspace_id: targetListing.workspace_id
            })
          };
        }

        if ((sourceListing.expires_at && (parseIsoMs(sourceListing.expires_at) ?? 0) < (parseIsoMs(recordedAt) ?? 0))
          || (targetListing.expires_at && (parseIsoMs(targetListing.expires_at) ?? 0) < (parseIsoMs(recordedAt) ?? 0))) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'expired listing cannot be linked', {
              reason_code: 'market_edge_invalid',
              source_listing_id: sourceListing.listing_id,
              target_listing_id: targetListing.listing_id
            })
          };
        }

        const subjectActor = resolveSubjectActor({ actor, auth });
        if (!listingOwnsActor(sourceListing, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'edge source owner actor required', {
              reason_code: 'market_edge_target_owner_required',
              actor: subjectActor,
              source_owner_actor: sourceListing.owner_actor
            })
          };
        }

        const requestedId = normalizeOptionalString(edge.edge_id);
        const edgeId = requestedId ?? nextEdgeId(this.store);
        if (this.store.state.market_edges[edgeId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge already exists', {
              reason_code: 'market_edge_invalid',
              edge_id: edgeId
            })
          };
        }

        const expiresAt = normalizeOptionalString(edge.expires_at);
        if (expiresAt && parseIsoMs(expiresAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge expiry timestamp', {
              reason_code: 'market_edge_invalid',
              expires_at: edge.expires_at
            })
          };
        }

        const record = {
          edge_id: edgeId,
          workspace_id: sourceListing.workspace_id,
          source_ref: sourceRef,
          target_ref: targetRef,
          edge_type: edgeType,
          status,
          terms_patch: isPlainObject(edge.terms_patch) ? clone(edge.terms_patch) : null,
          note: normalizeOptionalString(edge.note),
          expires_at: expiresAt,
          created_by: { type: subjectActor.type, id: subjectActor.id },
          created_at: recordedAt,
          updated_at: recordedAt
        };

        this.store.state.market_edges[edgeId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            edge: normalizeEdgeView(record)
          }
        };
      }
    });
  }

  _loadEdgeOrError({ edgeId, correlationId: corr }) {
    const record = this.store.state.market_edges?.[edgeId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'edge not found', {
          reason_code: 'market_edge_not_found',
          edge_id: edgeId
        })
      };
    }
    return { ok: true, record };
  }

  _transitionEdge({ actor, auth, edgeId, idempotencyKey, request, operationId, targetStatus }) {
    const corr = correlationId(operationId);

    const authz = this._authorize({ actor, auth, operationId, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadEdgeOrError({ edgeId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const edge = load.record;
        const sourceListing = this._resolveListingByRef(edge.source_ref);
        const targetListing = this._resolveListingByRef(edge.target_ref);
        const subjectActor = resolveSubjectActor({ actor, auth });

        const normalized = normalizeActionRequest(request, auth);
        if (!normalized.ok) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge timestamp', {
              reason_code: 'market_edge_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (edge.status !== 'open') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge status transition', {
              reason_code: 'market_edge_status_transition_invalid',
              edge_id: edgeId,
              from_status: edge.status,
              to_status: targetStatus
            })
          };
        }

        if (edge.expires_at && (parseIsoMs(edge.expires_at) ?? 0) < (parseIsoMs(normalized.recordedAt) ?? 0)) {
          edge.status = 'expired';
          edge.updated_at = normalized.recordedAt;
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge has expired', {
              reason_code: 'market_edge_status_transition_invalid',
              edge_id: edgeId,
              expires_at: edge.expires_at
            })
          };
        }

        if ((sourceListing?.expires_at && (parseIsoMs(sourceListing.expires_at) ?? 0) < (parseIsoMs(normalized.recordedAt) ?? 0))
          || (targetListing?.expires_at && (parseIsoMs(targetListing.expires_at) ?? 0) < (parseIsoMs(normalized.recordedAt) ?? 0))) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'expired listing cannot transition edge', {
              reason_code: 'market_edge_status_transition_invalid',
              edge_id: edgeId
            })
          };
        }

        if (targetStatus === 'withdrawn') {
          if (!sourceListing || !listingOwnsActor(sourceListing, subjectActor)) {
            return {
              ok: false,
              body: errorResponse(corr, 'FORBIDDEN', 'edge source owner actor required for withdraw', {
                reason_code: 'market_edge_target_owner_required',
                edge_id: edgeId,
                actor: subjectActor,
                source_owner_actor: sourceListing?.owner_actor ?? null
              })
            };
          }
        } else if (!targetListing || !listingOwnsActor(targetListing, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'edge target owner actor required', {
              reason_code: 'market_edge_target_owner_required',
              edge_id: edgeId,
              actor: subjectActor,
              target_owner_actor: targetListing?.owner_actor ?? null
            })
          };
        }

        edge.status = targetStatus;
        edge.updated_at = normalized.recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            edge: normalizeEdgeView(edge)
          }
        };
      }
    });
  }

  acceptEdge({ actor, auth, edgeId, idempotencyKey, request }) {
    return this._transitionEdge({
      actor,
      auth,
      edgeId,
      idempotencyKey,
      request,
      operationId: 'marketEdges.accept',
      targetStatus: 'accepted'
    });
  }

  patchEdge({ actor, auth, edgeId, idempotencyKey, request }) {
    const op = 'marketEdges.patch';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadEdgeOrError({ edgeId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const edge = load.record;
        const subjectActor = resolveSubjectActor({ actor, auth });
        const sourceListing = this._resolveListingByRef(edge.source_ref);
        if (!sourceListing || !listingOwnsActor(sourceListing, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'edge source owner actor required', {
              reason_code: 'market_edge_target_owner_required',
              edge_id: edgeId,
              actor: subjectActor,
              source_owner_actor: sourceListing?.owner_actor ?? null
            })
          };
        }

        if (edge.status !== 'open') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'edge status does not allow patch', {
              reason_code: 'market_edge_status_transition_invalid',
              edge_id: edgeId,
              status: edge.status
            })
          };
        }

        const patch = request?.patch;
        if (!isPlainObject(patch)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid market edge patch payload', {
              reason_code: 'market_edge_invalid'
            })
          };
        }

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge timestamp', {
              reason_code: 'market_edge_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        if (patch.terms_patch !== undefined) {
          edge.terms_patch = patch.terms_patch === null ? null : (isPlainObject(patch.terms_patch) ? clone(patch.terms_patch) : null);
        }

        if (patch.note !== undefined) {
          edge.note = normalizeOptionalString(patch.note);
        }

        if (patch.expires_at !== undefined) {
          const expiresAt = normalizeOptionalString(patch.expires_at);
          if (expiresAt && parseIsoMs(expiresAt) === null) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid edge expiry timestamp', {
                reason_code: 'market_edge_invalid',
                expires_at: patch.expires_at
              })
            };
          }
          edge.expires_at = expiresAt;
        }

        edge.updated_at = recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            edge: normalizeEdgeView(edge)
          }
        };
      }
    });
  }

  declineEdge({ actor, auth, edgeId, idempotencyKey, request }) {
    return this._transitionEdge({
      actor,
      auth,
      edgeId,
      idempotencyKey,
      request,
      operationId: 'marketEdges.decline',
      targetStatus: 'declined'
    });
  }

  withdrawEdge({ actor, auth, edgeId, idempotencyKey, request }) {
    return this._transitionEdge({
      actor,
      auth,
      edgeId,
      idempotencyKey,
      request,
      operationId: 'marketEdges.withdraw',
      targetStatus: 'withdrawn'
    });
  }

  getEdge({ actor, auth, edgeId }) {
    const op = 'marketEdges.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadEdgeOrError({ edgeId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };
    if (isPublicViewer(actor) && !edgeIsPublicVisible(this.store, load.record)) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'edge not found', {
          reason_code: 'market_edge_not_found',
          edge_id: edgeId
        })
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        edge: normalizeEdgeView(load.record)
      }
    };
  }

  listEdges({ actor, auth, query }) {
    const op = 'marketEdges.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeEdgeListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const rows = Object.values(this.store.state.market_edges ?? {})
      .filter(row => {
        if (isPublicViewer(actor) && !edgeIsPublicVisible(this.store, row)) return false;
        if (normalized.value.workspace_id && row.workspace_id !== normalized.value.workspace_id) return false;
        if (normalized.value.source_id && row.source_ref?.id !== normalized.value.source_id) return false;
        if (normalized.value.target_id && row.target_ref?.id !== normalized.value.target_id) return false;
        if (normalized.value.status && row.status !== normalized.value.status) return false;
        if (normalized.value.edge_type && row.edge_type !== normalized.value.edge_type) return false;
        return true;
      });

    sortByUpdatedDescThenId(rows, 'edge_id');

    const page = buildPaginationSlice({
      rows,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: row => [row.updated_at, row.edge_id],
      cursorParts: 2
    });

    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        edges: page.value.page.map(normalizeEdgeView),
        total: page.value.total,
        next_cursor: page.value.nextCursor
      }
    };
  }

  getFeed({ actor, auth, query }) {
    const op = 'marketFeed.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeFeedQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const items = [];

    for (const listing of Object.values(this.store.state.market_listings ?? {})) {
      if (isPublicViewer(actor) && !listingIsPublicVisible(listing)) continue;
      if (normalized.value.workspace_id && listing.workspace_id !== normalized.value.workspace_id) continue;
      if (normalized.value.item_type && normalized.value.item_type !== 'listing') continue;
      if (normalized.value.types.length > 0 && !normalized.value.types.includes('listing')) continue;
      items.push({
        item_type: 'listing',
        item_id: listing.listing_id,
        workspace_id: listing.workspace_id,
        occurred_at: listing.updated_at,
        listing_summary: {
          listing_id: listing.listing_id,
          kind: listing.kind,
          status: listing.status,
          title: listing.title,
          owner_actor: clone(listing.owner_actor),
          owner_profile: actorProfileSummary(this.store, listing.owner_actor),
          updated_at: listing.updated_at
        }
      });
    }

    for (const edge of Object.values(this.store.state.market_edges ?? {})) {
      if (isPublicViewer(actor) && !edgeIsPublicVisible(this.store, edge)) continue;
      if (normalized.value.workspace_id && edge.workspace_id !== normalized.value.workspace_id) continue;
      if (normalized.value.item_type && normalized.value.item_type !== 'edge') continue;
      if (normalized.value.types.length > 0 && !normalized.value.types.includes('edge')) continue;
      items.push({
        item_type: 'edge',
        item_id: edge.edge_id,
        workspace_id: edge.workspace_id,
        occurred_at: edge.updated_at,
        edge_summary: {
          edge_id: edge.edge_id,
          edge_type: edge.edge_type,
          status: edge.status,
          source_ref: clone(edge.source_ref),
          target_ref: clone(edge.target_ref),
          updated_at: edge.updated_at
        }
      });
    }

    for (const deal of Object.values(this.store.state.market_deals ?? {})) {
      if (isPublicViewer(actor) && !dealIsPublicVisible(this.store, deal)) continue;
      if (normalized.value.workspace_id && deal.workspace_id !== normalized.value.workspace_id) continue;
      if (normalized.value.item_type && normalized.value.item_type !== 'deal') continue;
      if (normalized.value.types.length > 0 && !normalized.value.types.includes('deal')) continue;
      items.push({
        item_type: 'deal',
        item_id: deal.deal_id,
        workspace_id: deal.workspace_id,
        occurred_at: deal.updated_at,
        deal_summary: {
          deal_id: deal.deal_id,
          origin_edge_id: deal.origin_edge_id,
          settlement_mode: deal.settlement_mode ?? null,
          status: deal.status,
          participants: clone(deal.participants ?? []),
          receipt_ref: deal.receipt_ref ?? null,
          updated_at: deal.updated_at
        }
      });
    }

    items.sort((a, b) => {
      const at = parseIsoMs(a.occurred_at) ?? 0;
      const bt = parseIsoMs(b.occurred_at) ?? 0;
      if (bt !== at) return bt - at;
      const typeCmp = String(a.item_type).localeCompare(String(b.item_type));
      if (typeCmp !== 0) return typeCmp;
      return String(a.item_id).localeCompare(String(b.item_id));
    });

    const page = buildPaginationSlice({
      rows: items,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: item => [item.occurred_at, item.item_type, item.item_id],
      cursorParts: 3
    });

    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        items: clone(page.value.page),
        next_cursor: page.value.nextCursor,
        server_time: normalizeOptionalString(auth?.now_iso) ?? new Date().toISOString()
      }
    };
  }

  _loadThreadOrError({ threadId, correlationId: corr }) {
    const record = this.store.state.market_threads?.[threadId] ?? null;
    if (!record) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'thread not found', {
          reason_code: 'market_thread_not_found',
          thread_id: threadId
        })
      };
    }
    return { ok: true, record };
  }

  _requireThreadParticipant({ thread, actor, correlationId: corr }) {
    if (includesActor(thread?.participants ?? [], actor)) return null;
    return {
      ok: false,
      body: errorResponse(corr, 'FORBIDDEN', 'thread participant required', {
        reason_code: 'market_thread_forbidden',
        actor,
        thread_id: thread?.thread_id ?? null
      })
    };
  }

  createThread({ actor, auth, idempotencyKey, request }) {
    const op = 'marketThreads.create';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const thread = request?.thread;
        if (!isPlainObject(thread)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid thread payload', {
              reason_code: 'market_thread_invalid'
            })
          };
        }

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid thread timestamp', {
              reason_code: 'market_thread_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const workspaceId = normalizeOptionalString(thread.workspace_id);
        const status = normalizeOptionalString(thread.status)?.toLowerCase() ?? 'active';
        const participants = normalizeParticipants(thread.participants);
        const anchorRef = thread.anchor_ref === undefined ? null : normalizeAnchorRef(thread.anchor_ref);
        const subjectActor = resolveSubjectActor({ actor, auth });

        if (!workspaceId || !participants || !THREAD_STATUS.has(status) || status !== 'active' || (thread.anchor_ref !== undefined && !anchorRef)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid thread payload', {
              reason_code: 'market_thread_invalid'
            })
          };
        }

        if (!includesActor(participants, subjectActor)) {
          return {
            ok: false,
            body: errorResponse(corr, 'FORBIDDEN', 'thread participants must include caller', {
              reason_code: 'market_thread_forbidden',
              actor: subjectActor,
              participants
            })
          };
        }

        const requestedId = normalizeOptionalString(thread.thread_id);
        const threadId = requestedId ?? nextThreadId(this.store);
        if (this.store.state.market_threads[threadId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'thread already exists', {
              reason_code: 'market_thread_invalid',
              thread_id: threadId
            })
          };
        }

        const record = {
          thread_id: threadId,
          workspace_id: workspaceId,
          participants,
          status,
          anchor_ref: anchorRef,
          created_at: recordedAt,
          updated_at: recordedAt
        };

        this.store.state.market_threads[threadId] = record;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            thread: normalizeThreadView(record)
          }
        };
      }
    });
  }

  getThread({ actor, auth, threadId }) {
    const op = 'marketThreads.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadThreadOrError({ threadId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };

    const participantGuard = this._requireThreadParticipant({ thread: load.record, actor: resolveSubjectActor({ actor, auth }), correlationId: corr });
    if (participantGuard) return participantGuard;

    return {
      ok: true,
      body: {
        correlation_id: corr,
        thread: normalizeThreadView(load.record)
      }
    };
  }

  listThreads({ actor, auth, query }) {
    const op = 'marketThreads.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const normalized = normalizeThreadListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const subjectActor = resolveSubjectActor({ actor, auth });
    const rows = Object.values(this.store.state.market_threads ?? {})
      .filter(row => {
        if (!includesActor(row.participants, subjectActor)) return false;
        if (normalized.value.workspace_id && row.workspace_id !== normalized.value.workspace_id) return false;
        if (normalized.value.status && row.status !== normalized.value.status) return false;
        if (normalized.value.participant_type || normalized.value.participant_id) {
          if (!row.participants.some(p => p.type === normalized.value.participant_type && p.id === normalized.value.participant_id)) return false;
        }
        return true;
      });

    sortByUpdatedDescThenId(rows, 'thread_id');

    const page = buildPaginationSlice({
      rows,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: row => [row.updated_at, row.thread_id],
      cursorParts: 2
    });

    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        threads: page.value.page.map(normalizeThreadView),
        total: page.value.total,
        next_cursor: page.value.nextCursor
      }
    };
  }

  createThreadMessage({ actor, auth, threadId, idempotencyKey, request }) {
    const op = 'marketThreadMessages.create';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: request,
      correlationId: corr,
      handler: () => {
        const load = this._loadThreadOrError({ threadId, correlationId: corr });
        if (!load.ok) return { ok: false, body: load.body };

        const thread = load.record;
        const subjectActor = resolveSubjectActor({ actor, auth });
        const participantGuard = this._requireThreadParticipant({ thread, actor: subjectActor, correlationId: corr });
        if (participantGuard) return participantGuard;

        if (thread.status !== 'active') {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'thread is not active', {
              reason_code: 'market_thread_invalid',
              thread_id: threadId,
              status: thread.status
            })
          };
        }

        const message = request?.message;
        if (!isPlainObject(message)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid message payload', {
              reason_code: 'market_message_invalid'
            })
          };
        }

        const recordedAt = normalizeRecordedAt(request, auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid message timestamp', {
              reason_code: 'market_message_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const messageType = normalizeOptionalString(message.message_type)?.toLowerCase() ?? null;
        const rawPayload = message.payload;
        if (!messageType || !MESSAGE_TYPES.has(messageType) || !isPlainObject(rawPayload)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid message payload', {
              reason_code: 'market_message_invalid'
            })
          };
        }

        const payload = clone(rawPayload);
        if (messageType === 'text') {
          const normalizedText =
            normalizeOptionalString(payload.text) ??
            normalizeOptionalString(payload.body) ??
            normalizeOptionalString(payload.message);
          if (!normalizedText) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'text messages require payload.text', {
                reason_code: 'market_message_invalid'
              })
            };
          }
          payload.text = normalizedText;
          if (!normalizeOptionalString(payload.body)) payload.body = normalizedText;
        }

        if (messageType === 'text' && !normalizeOptionalString(payload.text)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'text messages require payload.text', {
              reason_code: 'market_message_invalid'
            })
          };
        }

        const requestedMessageId = normalizeOptionalString(message.message_id);
        const messageId = requestedMessageId ?? nextMessageId(this.store);
        if (this.store.state.market_messages[messageId]) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'message already exists', {
              reason_code: 'market_message_invalid',
              message_id: messageId
            })
          };
        }

        const record = {
          message_id: messageId,
          thread_id: threadId,
          sender_actor: { type: subjectActor.type, id: subjectActor.id },
          message_type: messageType,
          payload,
          created_at: recordedAt
        };

        this.store.state.market_messages[messageId] = record;
        thread.updated_at = recordedAt;

        return {
          ok: true,
          body: {
            correlation_id: corr,
            message: normalizeMessageView(record)
          }
        };
      }
    });
  }

  listThreadMessages({ actor, auth, threadId, query }) {
    const op = 'marketThreadMessages.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const load = this._loadThreadOrError({ threadId, correlationId: corr });
    if (!load.ok) return { ok: false, body: load.body };

    const participantGuard = this._requireThreadParticipant({ thread: load.record, actor: resolveSubjectActor({ actor, auth }), correlationId: corr });
    if (participantGuard) return participantGuard;

    const normalized = normalizeMessageListQuery(query ?? {});
    if (!normalized.ok) {
      return {
        ok: false,
        body: errorResponse(corr, normalized.code, normalized.message, normalized.details)
      };
    }

    const rows = Object.values(this.store.state.market_messages ?? {})
      .filter(row => row.thread_id === threadId)
      .filter(row => {
        if (normalized.value.message_type && row.message_type !== normalized.value.message_type) return false;
        return true;
      });

    rows.sort((a, b) => {
      const at = parseIsoMs(a.created_at) ?? 0;
      const bt = parseIsoMs(b.created_at) ?? 0;
      if (at !== bt) return at - bt;
      return String(a.message_id).localeCompare(String(b.message_id));
    });

    const page = buildPaginationSlice({
      rows,
      limit: normalized.value.limit,
      cursorAfter: normalized.value.cursor_after,
      keyFn: row => [row.created_at, row.message_id],
      cursorParts: 2
    });

    if (!page.ok) {
      return {
        ok: false,
        body: errorResponse(corr, page.code, page.message, page.details)
      };
    }

    return {
      ok: true,
      body: {
        correlation_id: corr,
        messages: page.value.page.map(normalizeMessageView),
        total: page.value.total,
        next_cursor: page.value.nextCursor
      }
    };
  }
}
