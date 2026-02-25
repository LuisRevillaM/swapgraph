import { AnalyticsClient } from '../analytics/analyticsClient.mjs';
import { MarketplaceApiClient, ApiClientError } from '../api/apiClient.mjs';
import {
  buildIntentFromComposerDraft,
  composerDraftFromIntent,
  defaultComposerDraft,
  validateComposerDraft
} from '../features/intents/composer.mjs';
import { buildActiveTimelineModel } from '../features/active/timeline.mjs';
import { rankInboxCards } from '../features/inbox/proposals.mjs';
import {
  applyCacheSnapshotToStore,
  createCacheSnapshot,
  hasCachedReadSurface,
  parseCacheSnapshot,
  staleBannerCopy
} from '../features/offline/cacheSnapshot.mjs';
import {
  DEFAULT_NOTIFICATION_PREFS,
  isNotificationChannelEnabled,
  isWithinQuietHours,
  normalizeNotificationPrefs
} from '../features/notifications/preferences.mjs';
import { normalizePushPayload, routeForPushPayload } from '../features/notifications/pushRouting.mjs';
import {
  redactAnalyticsEvent,
  safeStorageRead,
  safeStorageWrite,
  sanitizeNotificationPrefsForStorage,
  sanitizeOfflineSnapshotForStorage
} from '../features/security/storagePolicy.mjs';
import { mapIntentDto } from '../domain/mappers.mjs';
import { createHashRouter, buildRouteHash } from '../routing/router.mjs';
import { SESSION_ACTOR_STORAGE_KEY, loadOrCreateActorId } from '../session/actorIdentity.mjs';
import { createMarketplaceStore } from '../state/store.mjs';
import { createMarketplaceShell } from '../ui/shell.mjs';

const NOTIFICATION_PREFS_STORAGE_KEY = 'swapgraph.marketplace.notification_prefs.v1';
const OFFLINE_CACHE_STORAGE_KEY = 'swapgraph.marketplace.offline_cache.v1';
const CSRF_TOKEN_STORAGE_KEY = 'swapgraph.marketplace.csrf_token.v1';
const MAX_OFFLINE_SNAPSHOT_BYTES = 320_000;

function loadOrCreateCsrfToken(storage) {
  const existing = safeStorageRead(storage, CSRF_TOKEN_STORAGE_KEY);
  if (existing && String(existing).trim()) return String(existing).trim();
  const generated = `csrf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  safeStorageWrite(storage, CSRF_TOKEN_STORAGE_KEY, generated);
  return generated;
}

function loadNotificationPrefs(storage) {
  if (!storage) return normalizeNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
  const raw = safeStorageRead(storage, NOTIFICATION_PREFS_STORAGE_KEY);
  if (!raw) return normalizeNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
  try {
    return sanitizeNotificationPrefsForStorage(JSON.parse(raw));
  } catch {
    return normalizeNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
  }
}

function persistNotificationPrefs(storage, prefs) {
  if (!storage) return;
  const normalized = sanitizeNotificationPrefsForStorage(prefs);
  safeStorageWrite(storage, NOTIFICATION_PREFS_STORAGE_KEY, JSON.stringify(normalized));
}

function loadOfflineSnapshot(storage) {
  if (!storage) return null;
  return parseCacheSnapshot(safeStorageRead(storage, OFFLINE_CACHE_STORAGE_KEY));
}

function persistOfflineSnapshot(storage, stateSnapshot) {
  if (!storage) return;
  const cacheSnapshot = sanitizeOfflineSnapshotForStorage(createCacheSnapshot(stateSnapshot));
  const serialized = JSON.stringify(cacheSnapshot);
  if (serialized.length > MAX_OFFLINE_SNAPSHOT_BYTES) return;
  safeStorageWrite(storage, OFFLINE_CACHE_STORAGE_KEY, serialized);
}

function isNavigatorOffline(windowRef) {
  return Boolean(windowRef?.navigator) && windowRef.navigator.onLine === false;
}

function toErrorSummary(error) {
  if (error instanceof ApiClientError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status
    };
  }
  return {
    code: 'UNEXPECTED',
    message: String(error?.message ?? error),
    status: 0
  };
}

function replaceIntentById(intents, nextIntent) {
  const rows = Array.isArray(intents) ? intents.slice() : [];
  const index = rows.findIndex(intent => intent?.id === nextIntent?.id);
  if (index === -1) return [nextIntent, ...rows];
  rows[index] = nextIntent;
  return rows;
}

function byIntentId(intents, intentId) {
  return (Array.isArray(intents) ? intents : []).find(intent => intent?.id === intentId) ?? null;
}

function intentSortValue(sort) {
  return sort === 'also_tradable' ? 'also_tradable' : 'highest_demand';
}

function rankNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function proposalCardForState(snapshot, proposalId) {
  const ranked = rankInboxCards({
    proposals: snapshot?.caches?.proposals?.items ?? [],
    intents: snapshot?.caches?.intents?.items ?? []
  });
  const card = ranked.cards.find(row => row.proposalId === proposalId) ?? null;
  return {
    card,
    stats: ranked.stats
  };
}

const TERMINAL_RECEIPT_STATES = new Set(['completed', 'failed']);
const RECEIPT_PROBE_LIMIT = 24;

function isoMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function receiptRowsForState(snapshot) {
  const rowsById = new Map();
  const receiptCache = snapshot?.caches?.receipts ?? {};

  for (const [cacheKey, entry] of Object.entries(receiptCache)) {
    const receipt = entry?.value ?? null;
    if (!receipt) continue;
    const cycleId = String(receipt?.cycleId ?? cacheKey ?? '').trim();
    const receiptId = String(receipt?.id ?? '').trim();
    if (!cycleId && !receiptId) continue;

    const dedupeKey = receiptId || cycleId;
    const row = {
      cacheKey: cycleId || cacheKey,
      cycleId: cycleId || cacheKey,
      receiptId: receiptId || cycleId || cacheKey,
      receipt,
      updatedAt: Number(entry?.updatedAt ?? 0),
      createdAtMs: isoMs(receipt?.createdAt)
    };

    const existing = rowsById.get(dedupeKey);
    if (!existing || row.updatedAt > existing.updatedAt) rowsById.set(dedupeKey, row);
  }

  return [...rowsById.values()].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.receiptId).localeCompare(String(b.receiptId));
  });
}

function receiptContextForRoute(snapshot, routeReceiptId) {
  if (!routeReceiptId) return null;
  const routeValue = String(routeReceiptId);
  const direct = snapshot?.caches?.receipts?.[routeValue]?.value ?? null;
  if (direct) {
    return {
      cacheKey: routeValue,
      cycleId: String(direct?.cycleId ?? routeValue),
      receiptId: String(direct?.id ?? routeValue),
      receipt: direct
    };
  }

  return receiptRowsForState(snapshot)
    .find(row => row.cacheKey === routeValue || row.receiptId === routeValue || row.cycleId === routeValue)
    ?? null;
}

function receiptVerificationStatus(receipt) {
  if (!receipt) return 'unavailable';
  const hasKey = Boolean(receipt?.signature?.keyId);
  const hasAlg = Boolean(receipt?.signature?.algorithm);
  const hasSig = Boolean(receipt?.signature?.signature);
  if (hasKey && hasAlg && hasSig) return 'verified';
  if (!hasKey && !hasAlg && !hasSig) return 'missing_signature';
  return 'partial_signature';
}

function hasTimelineForCycle(snapshot, cycleId) {
  if (!cycleId) return false;
  if (snapshot?.caches?.timeline?.[cycleId]?.value) return true;
  return Object.values(snapshot?.caches?.timeline ?? {})
    .some(row => String(row?.value?.cycleId ?? '') === String(cycleId));
}

function receiptCandidateCycleIds(snapshot, routeReceiptId = null) {
  const candidates = new Set();

  for (const row of receiptRowsForState(snapshot)) {
    candidates.add(row.cycleId);
  }

  for (const [cacheKey, entry] of Object.entries(snapshot?.caches?.timeline ?? {})) {
    const state = String(entry?.value?.state ?? '').trim();
    if (!TERMINAL_RECEIPT_STATES.has(state)) continue;
    const cycleId = String(entry?.value?.cycleId ?? cacheKey ?? '').trim();
    if (cycleId) candidates.add(cycleId);
  }

  for (const proposal of snapshot?.caches?.proposals?.items ?? []) {
    const cycleId = String(proposal?.id ?? '').trim();
    if (cycleId) candidates.add(cycleId);
  }

  const routeValue = String(routeReceiptId ?? '').trim();
  if (routeValue) candidates.add(routeValue);

  return [...candidates].slice(0, RECEIPT_PROBE_LIMIT);
}

export function bootstrapMarketplaceClient({ root, windowRef = window }) {
  if (!root) throw new Error('root is required');

  const storage = windowRef?.localStorage ?? null;
  const actorId = loadOrCreateActorId({ storage, locationSearch: windowRef?.location?.search ?? '' });
  const csrfToken = loadOrCreateCsrfToken(storage);
  const pendingIntentMutations = new Set();
  const pendingProposalMutations = new Set();
  const pendingActiveMutations = new Set();
  const knownMissingReceipts = new Set();
  let pendingProposalOpen = null;
  let pendingReceiptOpen = null;

  const analytics = new AnalyticsClient({
    sink: event => {
      // eslint-disable-next-line no-console
      console.debug('[marketplace.analytics]', redactAnalyticsEvent(event));
    }
  });

  const store = createMarketplaceStore();
  const initialNotificationPrefs = loadNotificationPrefs(storage);
  const restoredSnapshot = loadOfflineSnapshot(storage);
  const initialOnline = !isNavigatorOffline(windowRef);

  store.setNotificationPrefs(initialNotificationPrefs);
  store.setNetworkOnline(initialOnline);
  store.setSessionActorId(actorId);
  if (restoredSnapshot) {
    applyCacheSnapshotToStore(store, restoredSnapshot);
  }

  const api = new MarketplaceApiClient({
    getActorContext: () => ({
      actorType: 'user',
      actorId,
      scopes: ['swap_intents:read', 'swap_intents:write', 'cycle_proposals:read', 'settlement:read', 'settlement:write', 'receipts:read', 'commits:write']
    }),
    getCsrfToken: () => csrfToken,
    onRetry: retry => {
      analytics.track('marketplace.api_retry', {
        operation: retry.operation,
        attempt: retry.attempt,
        delay_ms: retry.delayMs
      });
    }
  });

  function currentNotificationPrefs() {
    return normalizeNotificationPrefs(store.getState().ui?.notificationPrefs?.values ?? DEFAULT_NOTIFICATION_PREFS);
  }

  function offlineCopyForRoute(route) {
    const snapshot = store.getState();
    const hasCache = hasCachedReadSurface(snapshot, route?.tab, route?.params);
    return staleBannerCopy({
      tab: route?.tab,
      offline: true,
      hasCache,
      savedAtMs: restoredSnapshot?.savedAt ?? null
    });
  }

  function markOfflineState({ route, reason = 'navigator_offline', cacheHit = false }) {
    store.setStatusBanner(offlineCopyForRoute(route));
    analytics.track('marketplace.offline_cache_used', {
      tab: route?.tab ?? 'items',
      reason,
      cache_hit: Boolean(cacheHit)
    });
  }

  function shouldSuppressPush(payload, prefs) {
    if (!payload?.channel) return true;
    if (!isNotificationChannelEnabled(prefs, payload.channel)) return true;
    return isWithinQuietHours(prefs);
  }

  function pushTitleForPayload(payload) {
    if (payload.kind === 'proposal') return 'Proposal alert';
    if (payload.kind === 'active') return 'Active swap alert';
    if (payload.kind === 'receipt') return 'Receipt alert';
    return 'Marketplace alert';
  }

  async function hydrateRoute(route, { force = false } = {}) {
    const tab = route.tab;
    let usedStaleCache = false;
    store.setLoading(tab, true);
    store.clearError(tab);

    try {
      analytics.track('marketplace.route_opened', {
        tab,
        path: route.path
      });
      analytics.track('marketplace.tab_viewed', { tab });

      if (!force && isNavigatorOffline(windowRef)) {
        const snapshot = store.getState();
        const hasCache = hasCachedReadSurface(snapshot, tab, route?.params);
        usedStaleCache = true;

        if (hasCache) {
          markOfflineState({ route, reason: 'navigator_offline', cacheHit: true });
          return;
        }

        store.setError(tab, {
          code: 'OFFLINE_CACHE_MISS',
          message: 'offline and no cached data available',
          status: 0
        });
        markOfflineState({ route, reason: 'cache_miss', cacheHit: false });
        return;
      }

      if (tab === 'items') {
        const projectionCached = !force ? store.getFreshSingleton('inventoryAwakening') : null;
        if (!projectionCached) {
          const projection = await api.getInventoryAwakeningProjection();
          store.setSingletonCache('inventoryAwakening', projection.projection);
          analytics.track('marketplace.api_request', {
            operation: 'projection.inventory_awakening',
            method: 'GET',
            status: projection.status
          });
        }

        const intentsCached = !force ? store.getFreshCollection('intents') : null;
        if (!intentsCached) {
          const result = await api.listIntents();
          store.setCollectionCache('intents', result.intents);
          analytics.track('marketplace.api_request', {
            operation: 'intents.list',
            method: 'GET',
            status: result.status
          });
        }
      }

      if (tab === 'intents') {
        const intentsCached = !force ? store.getFreshCollection('intents') : null;
        if (!intentsCached) {
          const result = await api.listIntents();
          store.setCollectionCache('intents', result.intents);
          analytics.track('marketplace.api_request', {
            operation: 'intents.list',
            method: 'GET',
            status: result.status
          });
        }

        const proposalsCached = !force ? store.getFreshCollection('proposals') : null;
        if (!proposalsCached) {
          const proposals = await api.listProposals();
          store.setCollectionCache('proposals', proposals.proposals);
          analytics.track('marketplace.api_request', {
            operation: 'proposals.list',
            method: 'GET',
            status: proposals.status
          });
        }
      }

      if (tab === 'inbox') {
        const proposalsCached = !force ? store.getFreshCollection('proposals') : null;
        if (!proposalsCached) {
          const result = await api.listProposals();
          store.setCollectionCache('proposals', result.proposals);
          analytics.track('marketplace.api_request', {
            operation: 'proposals.list',
            method: 'GET',
            status: result.status
          });
        }

        const intentsCached = !force ? store.getFreshCollection('intents') : null;
        if (!intentsCached) {
          const intents = await api.listIntents();
          store.setCollectionCache('intents', intents.intents);
          analytics.track('marketplace.api_request', {
            operation: 'intents.list',
            method: 'GET',
            status: intents.status
          });
        }

        const snapshot = store.getState();
        const proposalContext = proposalCardForState(snapshot, route.params?.proposalId ?? null);
        analytics.track('marketplace.inbox_ranked', {
          proposal_count: proposalContext.stats.totalCount,
          urgent_count: proposalContext.stats.urgentCount
        });

        if (route.params?.proposalId) {
          analytics.track('marketplace.proposal_detail_viewed', {
            proposal_id: route.params.proposalId,
            rank: proposalContext.card?.rank ?? 0,
            urgency: proposalContext.card?.urgencyKind ?? 'normal'
          });
        }
      }

      if (tab === 'active' && route.params?.cycleId) {
        const cycleId = route.params.cycleId;
        const cached = !force ? store.getFreshEntity('timeline', cycleId) : null;
        if (!cached) {
          const result = await api.getTimeline(cycleId);
          store.setEntityCache('timeline', cycleId, result.timeline);
          analytics.track('marketplace.api_request', {
            operation: 'timeline.get',
            method: 'GET',
            status: result.status
          });
        }

        const snapshot = store.getState();
        const activeModel = buildActiveTimelineModel({
          timeline: snapshot.caches.timeline?.[cycleId]?.value ?? null,
          intents: snapshot.caches.intents?.items ?? [],
          viewerActorIdHint: actorId
        });
        if (activeModel) {
          analytics.track('marketplace.active_timeline_viewed', {
            cycle_id: cycleId,
            state: activeModel.state,
            wait_reason: activeModel.waitReasonCode
          });
        }
      }

      if (tab === 'receipts') {
        const proposalsCached = !force ? store.getFreshCollection('proposals') : null;
        if (!proposalsCached) {
          const proposals = await api.listProposals();
          store.setCollectionCache('proposals', proposals.proposals);
          analytics.track('marketplace.api_request', {
            operation: 'proposals.list',
            method: 'GET',
            status: proposals.status
          });
        }

        const receiptsSnapshot = store.getState();
        const candidateCycleIds = receiptCandidateCycleIds(receiptsSnapshot, route.params?.receiptId);
        const receiptLookups = candidateCycleIds.map(async cycleId => {
          if (!cycleId) return;
          const cached = !force ? store.getFreshEntity('receipts', cycleId) : null;
          if (cached) return;
          if (!force && knownMissingReceipts.has(cycleId)) return;

          try {
            const result = await api.getReceipt(cycleId);
            const cacheKey = String(result?.receipt?.cycleId ?? cycleId);
            store.setEntityCache('receipts', cacheKey, result.receipt);
            knownMissingReceipts.delete(cycleId);
            knownMissingReceipts.delete(cacheKey);
            analytics.track('marketplace.api_request', {
              operation: 'receipt.get',
              method: 'GET',
              status: result.status
            });
          } catch (error) {
            const normalized = toErrorSummary(error);
            if (normalized.code === 'NOT_FOUND') {
              knownMissingReceipts.add(cycleId);
              return;
            }
            throw error;
          }
        });

        await Promise.all(receiptLookups);

        const snapshot = store.getState();
        const rows = receiptRowsForState(snapshot);
        if (route.params?.receiptId) {
          const selected = receiptContextForRoute(snapshot, route.params.receiptId);
          const selectedCycleId = selected?.cycleId ?? route.params.receiptId;
          analytics.track('marketplace.receipt_detail_viewed', {
            receipt_id: selected?.receiptId ?? route.params.receiptId,
            cycle_id: selectedCycleId,
            final_state: String(selected?.receipt?.finalState ?? 'unknown'),
            verification_status: receiptVerificationStatus(selected?.receipt),
            has_value_context: hasTimelineForCycle(snapshot, selectedCycleId)
          });
        } else {
          analytics.track('marketplace.receipts_list_viewed', {
            receipt_count: rows.length,
            completed_count: rows.filter(row => row.receipt?.finalState === 'completed').length,
            failed_count: rows.filter(row => row.receipt?.finalState === 'failed').length
          });
        }
      }

      if (!usedStaleCache) {
        store.clearStatusBanner();
      }
    } catch (error) {
      const normalized = toErrorSummary(error);
      const snapshot = store.getState();
      const hasCache = hasCachedReadSurface(snapshot, tab, route?.params);
      if (normalized.code === 'NETWORK_ERROR' && hasCache) {
        usedStaleCache = true;
        store.clearError(tab);
        markOfflineState({ route, reason: 'network_error_fallback', cacheHit: true });
        return;
      }

      store.setError(tab, normalized);
      store.setStatusBanner({
        tone: 'danger',
        title: 'Read surface unavailable',
        message: `${normalized.code}: ${normalized.message}`
      });
      analytics.track('marketplace.api_error', {
        operation: `${tab}.hydrate`,
        code: normalized.code,
        status: normalized.status
      });
    } finally {
      store.setLoading(tab, false);
    }
  }

  async function submitIntentComposer(fields) {
    const snapshot = store.getState();
    const composer = snapshot.ui.composer;
    const mode = composer.mode === 'edit' ? 'edit' : 'create';
    const existingIntentId = mode === 'edit' ? composer.targetIntentId : null;
    const validation = validateComposerDraft({
      offeringAssetId: fields.offering_asset_id,
      offerValueUsd: fields.offer_value_usd,
      wantCategory: fields.want_category,
      acceptableWear: fields.acceptable_wear,
      valueToleranceUsd: fields.value_tolerance_usd,
      maxCycleLength: fields.max_cycle_length
    });

    if (!validation.ok) {
      store.setComposerValidationErrors(validation.errors);
      analytics.track('marketplace.intent_validation_failed', {
        mode,
        field_count: Object.keys(validation.errors).length
      });
      return;
    }

    const built = buildIntentFromComposerDraft({
      input: validation.draft,
      actorId,
      existingIntentId
    });
    if (!built.ok) {
      store.setComposerValidationErrors(built.errors);
      analytics.track('marketplace.intent_validation_failed', {
        mode,
        field_count: Object.keys(built.errors).length
      });
      return;
    }

    const mutationIntent = mapIntentDto(built.intent);
    const mutationKey = `${mode}:${mutationIntent.id}`;
    if (pendingIntentMutations.has(mutationKey)) return;

    const originalIntents = snapshot.caches.intents.items ?? [];
    const optimisticIntents = replaceIntentById(originalIntents, mutationIntent);
    const startedAt = Date.now();

    pendingIntentMutations.add(mutationKey);
    store.clearComposerValidationErrors();
    store.setComposerSubmitting(true);
    store.setIntentMutation(mutationIntent.id, { pending: true, kind: mode });
    store.setCollectionCache('intents', optimisticIntents);
    analytics.track('marketplace.intent_submit_started', {
      mode,
      intent_id: mutationIntent.id
    });

    try {
      const result = mode === 'edit'
        ? await api.updateIntent({ id: mutationIntent.id, intent: built.intent })
        : await api.createIntent({ intent: built.intent });

      store.setCollectionCache('intents', replaceIntentById(store.getState().caches.intents.items ?? [], result.intent));
      store.clearIntentMutation(mutationIntent.id);
      store.closeComposer();
      store.setStatusBanner({
        tone: 'signal',
        title: mode === 'edit' ? 'Intent updated' : 'Intent posted',
        message: mode === 'edit'
          ? 'Watching state refreshed with your new constraints.'
          : 'Watching state is active. Matching runs continuously.'
      });

      analytics.track('marketplace.intent_submit_succeeded', {
        mode,
        intent_id: mutationIntent.id,
        latency_ms: Date.now() - startedAt
      });
    } catch (error) {
      const normalized = toErrorSummary(error);
      store.setCollectionCache('intents', originalIntents);
      store.setIntentMutation(mutationIntent.id, {
        pending: false,
        kind: mode,
        error: normalized.code
      });
      store.setStatusBanner({
        tone: 'danger',
        title: mode === 'edit' ? 'Intent update failed' : 'Intent post failed',
        message: `${normalized.code}: ${normalized.message}`
      });
      analytics.track('marketplace.intent_submit_failed', {
        mode,
        intent_id: mutationIntent.id,
        code: normalized.code,
        status: normalized.status
      });
    } finally {
      pendingIntentMutations.delete(mutationKey);
      store.setComposerSubmitting(false);
    }
  }

  async function cancelIntent(intentId) {
    if (!intentId) return;
    const snapshot = store.getState();
    const originalIntents = snapshot.caches.intents.items ?? [];
    const originalIntent = byIntentId(originalIntents, intentId);
    if (!originalIntent) return;

    const mutationKey = `cancel:${intentId}`;
    if (pendingIntentMutations.has(mutationKey)) return;

    const optimisticIntents = replaceIntentById(originalIntents, {
      ...originalIntent,
      status: 'cancelled'
    });
    const startedAt = Date.now();

    pendingIntentMutations.add(mutationKey);
    store.setIntentMutation(intentId, { pending: true, kind: 'cancel' });
    store.setCollectionCache('intents', optimisticIntents);
    analytics.track('marketplace.intent_cancel_started', {
      intent_id: intentId
    });

    try {
      const result = await api.cancelIntent({ id: intentId });
      store.setCollectionCache('intents', replaceIntentById(store.getState().caches.intents.items ?? [], {
        ...originalIntent,
        status: result.cancel.status
      }));
      store.clearIntentMutation(intentId);
      store.setStatusBanner({
        tone: 'signal',
        title: 'Intent cancelled',
        message: 'This standing watch was stopped safely.'
      });
      analytics.track('marketplace.intent_cancel_succeeded', {
        intent_id: intentId,
        latency_ms: Date.now() - startedAt
      });
    } catch (error) {
      const normalized = toErrorSummary(error);
      store.setCollectionCache('intents', originalIntents);
      store.setIntentMutation(intentId, { pending: false, kind: 'cancel', error: normalized.code });
      store.setStatusBanner({
        tone: 'danger',
        title: 'Cancel failed',
        message: `${normalized.code}: ${normalized.message}`
      });
      analytics.track('marketplace.intent_cancel_failed', {
        intent_id: intentId,
        code: normalized.code,
        status: normalized.status
      });
    } finally {
      pendingIntentMutations.delete(mutationKey);
    }
  }

  async function submitProposalDecision({ proposalId, decision, rank }) {
    if (!proposalId) return;
    const normalizedDecision = decision === 'decline' ? 'decline' : 'accept';
    const settledStatus = normalizedDecision === 'accept' ? 'accepted' : 'declined';
    const mutationKey = `${normalizedDecision}:${proposalId}`;

    const snapshot = store.getState();
    const proposal = (snapshot.caches.proposals.items ?? []).find(row => row?.id === proposalId) ?? null;
    if (!proposal) return;

    const currentMutation = snapshot.ui.proposalMutations?.[proposalId] ?? null;
    if (currentMutation?.status === settledStatus) return;
    if (pendingProposalMutations.has(mutationKey)) return;

    const proposalContext = proposalCardForState(snapshot, proposalId);
    const rankValue = rankNumber(rank, proposalContext.card?.rank ?? 0);
    const startedAt = Date.now();

    pendingProposalMutations.add(mutationKey);
    store.setProposalMutation(proposalId, {
      pending: true,
      decision: normalizedDecision,
      status: null,
      error: null
    });

    analytics.track('marketplace.proposal_decision_started', {
      proposal_id: proposalId,
      decision: normalizedDecision,
      rank: rankValue
    });

    try {
      const result = normalizedDecision === 'accept'
        ? await api.acceptProposal({ proposalId })
        : await api.declineProposal({ proposalId });

      store.setProposalMutation(proposalId, {
        pending: false,
        decision: normalizedDecision,
        status: settledStatus,
        error: null,
        commitId: result.commit?.id ?? null
      });

      store.setStatusBanner({
        tone: 'signal',
        title: normalizedDecision === 'accept' ? 'Proposal accepted' : 'Proposal declined',
        message: normalizedDecision === 'accept'
          ? 'Commit registered. Settlement timeline will update as participants respond.'
          : 'Cycle was declined safely. Inbox ranking will continue to refresh.'
      });

      analytics.track('marketplace.proposal_decision_succeeded', {
        proposal_id: proposalId,
        decision: normalizedDecision,
        rank: rankValue,
        latency_ms: Date.now() - startedAt,
        retry_count: Number(result.retryCount ?? 0)
      });
    } catch (error) {
      const normalized = toErrorSummary(error);
      store.setProposalMutation(proposalId, {
        pending: false,
        decision: normalizedDecision,
        status: null,
        error: normalized.code
      });

      store.setStatusBanner({
        tone: 'danger',
        title: normalizedDecision === 'accept' ? 'Accept failed' : 'Decline failed',
        message: `${normalized.code}: ${normalized.message}`
      });

      analytics.track('marketplace.proposal_decision_failed', {
        proposal_id: proposalId,
        decision: normalizedDecision,
        rank: rankValue,
        code: normalized.code,
        status: normalized.status
      });
    } finally {
      pendingProposalMutations.delete(mutationKey);
    }
  }

  function activeStateForCycle(cycleId) {
    return String(store.getState().caches.timeline?.[cycleId]?.value?.state ?? 'proposed');
  }

  function normalizedActiveAction(eventType) {
    if (eventType === 'active.confirmDeposit') return 'confirm_deposit';
    if (eventType === 'active.beginExecution') return 'begin_execution';
    if (eventType === 'active.completeSettlement') return 'complete_settlement';
    if (eventType === 'active.openReceipt') return 'open_receipt';
    if (eventType === 'active.refreshCycle') return 'refresh_cycle';
    return null;
  }

  async function submitActiveAction({ cycleId, action }) {
    if (!cycleId || !action) return;

    const mutationKey = `${action}:${cycleId}`;
    if (pendingActiveMutations.has(mutationKey)) return;

    const beforeState = activeStateForCycle(cycleId);
    const startedAt = Date.now();

    pendingActiveMutations.add(mutationKey);
    store.setActiveMutation(cycleId, {
      pending: true,
      action,
      error: null
    });

    analytics.track('marketplace.active_action_tapped', {
      cycle_id: cycleId,
      action,
      state: beforeState,
      enabled: true
    });

    try {
      let result = null;
      if (action === 'confirm_deposit') {
        result = await api.confirmDeposit({ cycleId });
      } else if (action === 'begin_execution') {
        result = await api.beginExecution({ cycleId });
      } else if (action === 'complete_settlement') {
        result = await api.completeSettlement({ cycleId });
      } else {
        return;
      }

      if (result?.timeline) {
        store.setEntityCache('timeline', cycleId, result.timeline);
      }
      if (result?.receipt) {
        const receiptCycleId = String(result.receipt?.cycleId ?? cycleId);
        store.setEntityCache('receipts', receiptCycleId, result.receipt);
        knownMissingReceipts.delete(cycleId);
        knownMissingReceipts.delete(receiptCycleId);
      }

      store.setActiveMutation(cycleId, {
        pending: false,
        action,
        error: null
      });

      store.setStatusBanner({
        tone: 'signal',
        title: action === 'confirm_deposit'
          ? 'Deposit confirmed'
          : (action === 'begin_execution' ? 'Execution started' : 'Settlement completed'),
        message: action === 'confirm_deposit'
          ? 'Timeline updated with your deposit confirmation.'
          : (action === 'begin_execution'
            ? 'Execution phase is now active.'
            : 'Receipt is ready to review.')
      });

      const finalState = String(result?.timeline?.state ?? beforeState);
      analytics.track('marketplace.active_action_succeeded', {
        cycle_id: cycleId,
        action,
        state: finalState,
        latency_ms: Date.now() - startedAt
      });

      if (action === 'complete_settlement' && result?.receipt?.id) {
        pendingReceiptOpen = {
          cycleId,
          source: 'active_timeline'
        };
        analytics.track('marketplace.active_receipt_opened', {
          cycle_id: cycleId
        });
        router.navigate({ tab: 'receipts', params: { receiptId: cycleId } });
        return;
      }

      const route = store.getState().route;
      if (route?.tab === 'active' && route?.params?.cycleId === cycleId) {
        await hydrateRoute(route, { force: true });
      }
    } catch (error) {
      const normalized = toErrorSummary(error);
      store.setActiveMutation(cycleId, {
        pending: false,
        action,
        error: normalized.code
      });
      store.setStatusBanner({
        tone: 'danger',
        title: 'Active action failed',
        message: `${normalized.code}: ${normalized.message}`
      });
      analytics.track('marketplace.active_action_failed', {
        cycle_id: cycleId,
        action,
        state: beforeState,
        code: normalized.code,
        status: normalized.status
      });
    } finally {
      pendingActiveMutations.delete(mutationKey);
    }
  }

  function handlePushPayload(rawPayload, { source = 'simulated' } = {}) {
    const payload = normalizePushPayload(rawPayload);
    if (!payload) return;

    const prefs = currentNotificationPrefs();
    const quietHoursActive = isWithinQuietHours(prefs);
    const channelEnabled = isNotificationChannelEnabled(prefs, payload.channel);

    analytics.track('marketplace.push_received', {
      kind: payload.kind,
      channel: payload.channel,
      source
    });

    if (shouldSuppressPush(payload, prefs)) {
      analytics.track('marketplace.push_suppressed', {
        kind: payload.kind,
        channel: payload.channel,
        source,
        reason: quietHoursActive ? 'quiet_hours' : 'channel_disabled'
      });
      return;
    }

    const route = routeForPushPayload(payload);
    if (!route) return;

    if (payload.kind === 'receipt' && payload.cycleId) {
      pendingReceiptOpen = {
        cycleId: payload.cycleId,
        source: 'notification'
      };
    }

    analytics.track('marketplace.push_routed', {
      kind: payload.kind,
      channel: payload.channel,
      source,
      tab: route.tab,
      quiet_hours_active: quietHoursActive,
      channel_enabled: channelEnabled
    });

    store.setStatusBanner({
      tone: 'signal',
      title: pushTitleForPayload(payload),
      message: 'Opened the latest matching route from notification.'
    });

    router.navigate(route);
  }

  function openComposer(mode, intentId = null) {
    const state = store.getState();
    if (mode === 'edit') {
      const intent = byIntentId(state.caches.intents.items ?? [], intentId);
      if (!intent) return;
      store.openComposer({
        mode: 'edit',
        targetIntentId: intent.id,
        draft: composerDraftFromIntent(intent)
      });
      analytics.track('marketplace.intent_composer_opened', { mode: 'edit' });
      return;
    }

    const firstOfferAsset = (state.caches.intents.items ?? [])
      .flatMap(intent => intent?.offer ?? [])
      .find(asset => asset?.assetId)?.assetId ?? '';

    store.openComposer({
      mode: 'create',
      draft: defaultComposerDraft({
        offeringAssetId: firstOfferAsset
      })
    });
    analytics.track('marketplace.intent_composer_opened', { mode: 'create' });
  }

  function handleUiEvent(event) {
    if (!event?.type) return;

    if (event.type === 'notifications.openPrefs') {
      store.openNotificationPrefs();
      analytics.track('marketplace.notification_preferences_opened', {
        source: 'ui'
      });
      return;
    }

    if (event.type === 'notifications.closePrefs') {
      store.closeNotificationPrefs();
      return;
    }

    if (event.type === 'notifications.savePrefs') {
      const nextPrefs = normalizeNotificationPrefs({
        channels: {
          proposal: Boolean(event?.fields?.channel_proposal),
          active: Boolean(event?.fields?.channel_active),
          receipt: Boolean(event?.fields?.channel_receipt)
        },
        quietHours: {
          enabled: Boolean(event?.fields?.quiet_enabled),
          startHour: Number(event?.fields?.quiet_start_hour),
          endHour: Number(event?.fields?.quiet_end_hour)
        }
      });

      store.setNotificationPrefs(nextPrefs);
      store.closeNotificationPrefs();
      persistNotificationPrefs(storage, nextPrefs);

      analytics.track('marketplace.notification_preferences_saved', {
        proposal_enabled: nextPrefs.channels.proposal,
        active_enabled: nextPrefs.channels.active,
        receipt_enabled: nextPrefs.channels.receipt,
        quiet_hours_enabled: nextPrefs.quietHours.enabled,
        quiet_hours_start: nextPrefs.quietHours.startHour,
        quiet_hours_end: nextPrefs.quietHours.endHour
      });

      store.setStatusBanner({
        tone: 'signal',
        title: 'Notification preferences saved',
        message: 'Alert routing now follows your updated channel and quiet-hour settings.'
      });
      return;
    }

    if (event.type === 'items.openInbox') {
      const projection = store.getState().caches.inventoryAwakening.value;
      const opportunities = Number(projection?.swappabilitySummary?.cycleOpportunities ?? 0);
      analytics.track('marketplace.items_demand_banner_tapped', {
        opportunity_count: opportunities
      });
      router.navigate({ tab: 'inbox', params: {} });
      return;
    }

    if (event.type === 'items.sort') {
      const sort = intentSortValue(event.sort);
      store.setItemsSort(sort);
      analytics.track('marketplace.items_sort_changed', { sort });
      return;
    }

    if (event.type.startsWith('active.')) {
      const route = store.getState().route;
      const cycleId = event.cycleId ?? route?.params?.cycleId ?? null;
      const action = normalizedActiveAction(event.type);
      if (!action || !cycleId) return;

      if (action === 'refresh_cycle') {
        analytics.track('marketplace.active_action_tapped', {
          cycle_id: cycleId,
          action,
          state: activeStateForCycle(cycleId),
          enabled: true
        });
        hydrateRoute(route, { force: true }).catch(() => {
          /* handled by hydrateRoute */
        });
        return;
      }

      if (action === 'open_receipt') {
        pendingReceiptOpen = {
          cycleId,
          source: 'active_timeline'
        };
        analytics.track('marketplace.active_action_tapped', {
          cycle_id: cycleId,
          action,
          state: activeStateForCycle(cycleId),
          enabled: true
        });
        analytics.track('marketplace.active_receipt_opened', {
          cycle_id: cycleId
        });
        router.navigate({ tab: 'receipts', params: { receiptId: cycleId } });
        return;
      }

      submitActiveAction({ cycleId, action }).catch(() => {
        /* error path handled in submitActiveAction */
      });
      return;
    }

    if (event.type === 'inbox.openProposal') {
      if (!event.proposalId) return;
      const snapshot = store.getState();
      const proposalContext = proposalCardForState(snapshot, event.proposalId);
      const rankValue = rankNumber(event.rank, proposalContext.card?.rank ?? 0);

      pendingProposalOpen = {
        proposalId: event.proposalId,
        source: 'inbox_card',
        rank: rankValue
      };

      router.navigate({ tab: 'inbox', params: { proposalId: event.proposalId } });
      return;
    }

    if (event.type === 'receipts.openReceipt') {
      const routeReceiptId = event.receiptId ?? event.cycleId ?? null;
      if (!routeReceiptId) return;
      pendingReceiptOpen = {
        cycleId: routeReceiptId,
        source: 'receipts_list'
      };
      router.navigate({ tab: 'receipts', params: { receiptId: routeReceiptId } });
      return;
    }

    if (event.type === 'receipt.backToList') {
      router.navigate({ tab: 'receipts', params: {} });
      return;
    }

    if (event.type === 'proposal.backToInbox') {
      router.navigate({ tab: 'inbox', params: {} });
      return;
    }

    if (event.type === 'composer.open') {
      openComposer('create');
      return;
    }

    if (event.type === 'composer.edit') {
      openComposer('edit', event.intentId);
      return;
    }

    if (event.type === 'composer.close') {
      store.closeComposer();
      return;
    }

    if (event.type === 'composer.submit') {
      submitIntentComposer(event.fields ?? {}).catch(() => {
        /* error path handled in submitIntentComposer */
      });
      return;
    }

    if (event.type === 'intent.cancel') {
      cancelIntent(event.intentId).catch(() => {
        /* error path handled in cancelIntent */
      });
      return;
    }

    if (event.type === 'proposal.accept' || event.type === 'proposal.decline') {
      submitProposalDecision({
        proposalId: event.proposalId,
        decision: event.type === 'proposal.decline' ? 'decline' : 'accept',
        rank: event.rank
      }).catch(() => {
        /* error path handled in submitProposalDecision */
      });
    }
  }

  const shell = createMarketplaceShell({
    root,
    onNavigate: routeInput => {
      router.navigate(routeInput);
    },
    onReload: () => {
      hydrateRoute(store.getState().route, { force: true });
    },
    onUiEvent: handleUiEvent,
    onSwitchAccount: () => {
      try {
        storage?.removeItem?.(SESSION_ACTOR_STORAGE_KEY);
      } catch {
        // ignore storage clear failures
      }
      windowRef.location.reload();
    }
  });

  const unsubscribe = store.subscribe(snapshot => {
    persistOfflineSnapshot(storage, snapshot);
    shell.render(snapshot);
  });

  const router = createHashRouter({
    windowRef,
    onRouteChange: route => {
      if (route?.tab === 'inbox' && route?.params?.proposalId) {
        const pending = pendingProposalOpen;
        const proposalId = route.params.proposalId;
        const rankValue = pending?.proposalId === proposalId
          ? rankNumber(pending.rank, 0)
          : 0;
        const source = pending?.proposalId === proposalId
          ? pending.source
          : 'deep_link';

        analytics.track('marketplace.proposal_opened', {
          proposal_id: proposalId,
          rank: rankValue,
          source
        });
      }

      if (route?.tab === 'receipts' && route?.params?.receiptId) {
        const routeReceiptId = route.params.receiptId;
        const pending = pendingReceiptOpen;
        const source = pending?.cycleId === routeReceiptId ? pending.source : 'deep_link';
        const snapshot = store.getState();
        const context = receiptContextForRoute(snapshot, routeReceiptId);

        analytics.track('marketplace.receipt_opened', {
          receipt_id: context?.receiptId ?? routeReceiptId,
          cycle_id: context?.cycleId ?? routeReceiptId,
          source
        });
      }

      pendingProposalOpen = null;
      pendingReceiptOpen = null;
      store.setRoute(route);
      hydrateRoute(route).catch(() => {
        /* handled by hydrateRoute */
      });
    }
  });

  const initialRoute = router.start();
  if (initialRoute?.hash !== windowRef.location.hash) {
    router.navigate(buildRouteHash(initialRoute), { replace: true });
  }

  const onOffline = () => {
    store.setNetworkOnline(false);
    analytics.track('marketplace.offline_state_changed', {
      online: false,
      source: 'navigator'
    });
    markOfflineState({ route: store.getState().route, reason: 'offline_event', cacheHit: true });
  };

  const onOnline = () => {
    store.setNetworkOnline(true);
    analytics.track('marketplace.offline_state_changed', {
      online: true,
      source: 'navigator'
    });
    store.setStatusBanner(staleBannerCopy({
      tab: store.getState().route?.tab ?? 'items',
      offline: false
    }));
    hydrateRoute(store.getState().route, { force: true }).catch(() => {
      /* handled by hydrateRoute */
    });
  };

  const onPushEvent = event => {
    handlePushPayload(event?.detail ?? null, { source: 'window_event' });
  };

  const onServiceWorkerMessage = event => {
    handlePushPayload(event?.data ?? null, { source: 'service_worker' });
  };

  windowRef.addEventListener('offline', onOffline);
  windowRef.addEventListener('online', onOnline);
  windowRef.addEventListener('swapgraph:push', onPushEvent);
  windowRef.navigator?.serviceWorker?.addEventListener?.('message', onServiceWorkerMessage);

  analytics.track('marketplace.offline_state_changed', {
    online: initialOnline,
    source: 'navigator'
  });

  if (!initialOnline) {
    markOfflineState({ route: store.getState().route, reason: 'initial_offline', cacheHit: true });
  }

  return {
    destroy() {
      router.stop();
      unsubscribe();
      windowRef.removeEventListener('offline', onOffline);
      windowRef.removeEventListener('online', onOnline);
      windowRef.removeEventListener('swapgraph:push', onPushEvent);
      windowRef.navigator?.serviceWorker?.removeEventListener?.('message', onServiceWorkerMessage);
    },
    store,
    router,
    api,
    analytics
  };
}
