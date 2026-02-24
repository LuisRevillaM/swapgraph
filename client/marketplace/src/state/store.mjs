import { DEFAULT_TAB_ID } from '../app/tabs.mjs';

const TAB_IDS = ['items', 'intents', 'inbox', 'active', 'receipts'];

export const CACHE_BOUNDARIES = Object.freeze({
  health: Object.freeze({ owner: 'WEB-T008', shape: 'singleton', ttlMs: 15000, source: '/healthz' }),
  inventoryAwakening: Object.freeze({ owner: 'WEB-T011', shape: 'singleton', ttlMs: 15000, source: '/product-projections/inventory-awakening' }),
  intents: Object.freeze({ owner: 'WEB-T008', shape: 'collection', ttlMs: 15000, source: '/swap-intents' }),
  proposals: Object.freeze({ owner: 'WEB-T008', shape: 'collection', ttlMs: 15000, source: '/cycle-proposals' }),
  matchingRuns: Object.freeze({ owner: 'WEB-T008', shape: 'entity', ttlMs: 30000, source: '/marketplace/matching/runs/{run_id}' }),
  timeline: Object.freeze({ owner: 'WEB-T008', shape: 'entity', ttlMs: 10000, source: '/settlement/{cycle_id}/status' }),
  receipts: Object.freeze({ owner: 'WEB-T008', shape: 'entity', ttlMs: 60000, source: '/receipts/{cycle_id}' })
});

function blankByTab() {
  return {
    items: null,
    intents: null,
    inbox: null,
    active: null,
    receipts: null
  };
}

function assertKnownTab(tab) {
  if (!TAB_IDS.includes(tab)) throw new Error(`unknown tab: ${String(tab)}`);
}

function assertKnownCache(cacheKey) {
  if (!(cacheKey in CACHE_BOUNDARIES)) throw new Error(`unknown cache boundary: ${String(cacheKey)}`);
}

function normalizeItemsSort(sort) {
  return sort === 'also_tradable' ? 'also_tradable' : 'highest_demand';
}

function normalizeNotificationPrefs(prefs = {}) {
  const channels = prefs?.channels ?? {};
  const quietHours = prefs?.quietHours ?? {};

  const asBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const asHour = (value, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const hour = Math.trunc(parsed);
    if (hour < 0 || hour > 23) return fallback;
    return hour;
  };

  return {
    channels: {
      proposal: asBoolean(channels.proposal, true),
      active: asBoolean(channels.active, true),
      receipt: asBoolean(channels.receipt, true)
    },
    quietHours: {
      enabled: asBoolean(quietHours.enabled, false),
      startHour: asHour(quietHours.startHour, 22),
      endHour: asHour(quietHours.endHour, 7)
    }
  };
}

export function createMarketplaceStore({ now = () => Date.now() } = {}) {
  const listeners = new Set();

  const state = {
    session: {
      actorId: null
    },
    network: {
      online: true
    },
    route: {
      tab: DEFAULT_TAB_ID,
      path: '/items',
      deepLinkKind: null,
      params: {},
      hash: '#/items'
    },
    loadingByTab: {
      items: false,
      intents: false,
      inbox: false,
      active: false,
      receipts: false
    },
    errorByTab: blankByTab(),
    statusBanner: null,
    caches: {
      health: { value: null, updatedAt: 0 },
      inventoryAwakening: { value: null, updatedAt: 0 },
      intents: { items: [], updatedAt: 0 },
      proposals: { items: [], updatedAt: 0 },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    },
    ui: {
      itemsSort: 'highest_demand',
      composer: {
        isOpen: false,
        mode: 'create',
        targetIntentId: null,
        draft: null,
        errors: {},
        submitting: false
      },
      notificationPrefs: {
        isOpen: false,
        values: normalizeNotificationPrefs()
      },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    }
  };

  const emit = () => {
    const snapshot = store.getState();
    listeners.forEach(listener => listener(snapshot));
  };

  const store = {
    getState() {
      return structuredClone(state);
    },

    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    setRoute(route) {
      state.route = {
        tab: route?.tab ?? DEFAULT_TAB_ID,
        path: route?.path ?? '/items',
        deepLinkKind: route?.deepLinkKind ?? null,
        params: route?.params ?? {},
        hash: route?.hash ?? '#/items'
      };
      emit();
    },

    setSessionActorId(actorId) {
      state.session.actorId = typeof actorId === 'string' && actorId.trim() ? actorId.trim() : null;
      emit();
    },

    setNetworkOnline(online) {
      state.network.online = Boolean(online);
      emit();
    },

    setLoading(tab, loading) {
      assertKnownTab(tab);
      state.loadingByTab[tab] = Boolean(loading);
      emit();
    },

    setError(tab, error) {
      assertKnownTab(tab);
      state.errorByTab[tab] = error ?? null;
      emit();
    },

    clearError(tab) {
      assertKnownTab(tab);
      state.errorByTab[tab] = null;
      emit();
    },

    setStatusBanner(banner) {
      state.statusBanner = banner ?? null;
      emit();
    },

    clearStatusBanner() {
      state.statusBanner = null;
      emit();
    },

    setItemsSort(sort) {
      state.ui.itemsSort = normalizeItemsSort(sort);
      emit();
    },

    openNotificationPrefs() {
      state.ui.notificationPrefs.isOpen = true;
      emit();
    },

    closeNotificationPrefs() {
      state.ui.notificationPrefs.isOpen = false;
      emit();
    },

    setNotificationPrefs(nextValues) {
      state.ui.notificationPrefs.values = normalizeNotificationPrefs(nextValues);
      emit();
    },

    openComposer({ mode = 'create', targetIntentId = null, draft = null } = {}) {
      state.ui.composer = {
        isOpen: true,
        mode: mode === 'edit' ? 'edit' : 'create',
        targetIntentId: targetIntentId ?? null,
        draft: draft ? structuredClone(draft) : null,
        errors: {},
        submitting: false
      };
      emit();
    },

    closeComposer() {
      state.ui.composer = {
        isOpen: false,
        mode: 'create',
        targetIntentId: null,
        draft: null,
        errors: {},
        submitting: false
      };
      emit();
    },

    setComposerValidationErrors(errors = {}) {
      state.ui.composer.errors = { ...(errors ?? {}) };
      emit();
    },

    clearComposerValidationErrors() {
      state.ui.composer.errors = {};
      emit();
    },

    setComposerSubmitting(submitting) {
      state.ui.composer.submitting = Boolean(submitting);
      emit();
    },

    setIntentMutation(intentId, mutation = null) {
      if (!intentId || typeof intentId !== 'string') throw new Error('intentId is required');
      if (!mutation) {
        delete state.ui.intentMutations[intentId];
      } else {
        state.ui.intentMutations[intentId] = { ...mutation };
      }
      emit();
    },

    clearIntentMutation(intentId) {
      if (!intentId || typeof intentId !== 'string') return;
      delete state.ui.intentMutations[intentId];
      emit();
    },

    setProposalMutation(proposalId, mutation = null) {
      if (!proposalId || typeof proposalId !== 'string') throw new Error('proposalId is required');
      if (!mutation) {
        delete state.ui.proposalMutations[proposalId];
      } else {
        state.ui.proposalMutations[proposalId] = { ...mutation };
      }
      emit();
    },

    clearProposalMutation(proposalId) {
      if (!proposalId || typeof proposalId !== 'string') return;
      delete state.ui.proposalMutations[proposalId];
      emit();
    },

    setActiveMutation(cycleId, mutation = null) {
      if (!cycleId || typeof cycleId !== 'string') throw new Error('cycleId is required');
      if (!mutation) {
        delete state.ui.activeMutations[cycleId];
      } else {
        state.ui.activeMutations[cycleId] = { ...mutation };
      }
      emit();
    },

    clearActiveMutation(cycleId) {
      if (!cycleId || typeof cycleId !== 'string') return;
      delete state.ui.activeMutations[cycleId];
      emit();
    },

    setSingletonCache(cacheKey, value) {
      assertKnownCache(cacheKey);
      if (CACHE_BOUNDARIES[cacheKey].shape !== 'singleton') {
        throw new Error(`cache boundary ${cacheKey} is not singleton`);
      }
      state.caches[cacheKey] = { value, updatedAt: now() };
      emit();
    },

    setCollectionCache(cacheKey, items) {
      assertKnownCache(cacheKey);
      if (CACHE_BOUNDARIES[cacheKey].shape !== 'collection') {
        throw new Error(`cache boundary ${cacheKey} is not collection`);
      }
      state.caches[cacheKey] = { items: Array.isArray(items) ? items : [], updatedAt: now() };
      emit();
    },

    setEntityCache(cacheKey, entityId, entityValue) {
      assertKnownCache(cacheKey);
      if (CACHE_BOUNDARIES[cacheKey].shape !== 'entity') {
        throw new Error(`cache boundary ${cacheKey} is not entity`);
      }
      if (!entityId || typeof entityId !== 'string') throw new Error('entityId is required');
      state.caches[cacheKey][entityId] = {
        value: entityValue,
        updatedAt: now()
      };
      emit();
    },

    getFreshSingleton(cacheKey) {
      assertKnownCache(cacheKey);
      const boundary = CACHE_BOUNDARIES[cacheKey];
      const entry = state.caches[cacheKey];
      if (boundary.shape !== 'singleton') return null;
      if (!entry || !entry.updatedAt) return null;
      if ((now() - entry.updatedAt) > boundary.ttlMs) return null;
      return entry.value;
    },

    getFreshCollection(cacheKey) {
      assertKnownCache(cacheKey);
      const boundary = CACHE_BOUNDARIES[cacheKey];
      const entry = state.caches[cacheKey];
      if (boundary.shape !== 'collection') return null;
      if (!entry || !entry.updatedAt) return null;
      if ((now() - entry.updatedAt) > boundary.ttlMs) return null;
      return entry.items;
    },

    getFreshEntity(cacheKey, entityId) {
      assertKnownCache(cacheKey);
      const boundary = CACHE_BOUNDARIES[cacheKey];
      if (boundary.shape !== 'entity') return null;
      const entry = state.caches[cacheKey]?.[entityId];
      if (!entry || !entry.updatedAt) return null;
      if ((now() - entry.updatedAt) > boundary.ttlMs) return null;
      return entry.value;
    }
  };

  return store;
}
