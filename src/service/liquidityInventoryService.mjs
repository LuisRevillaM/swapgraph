import { authorizeApiOperation } from '../core/authz.mjs';
import { idempotencyScopeKey, payloadHash } from '../core/idempotency.mjs';
import { buildSignedPolicyAuditExportPayload } from '../crypto/policyIntegritySigning.mjs';

const ACTIVE_RESERVATION_STATUSES = new Set(['reserved', 'in_settlement']);
const TERMINAL_RESERVATION_STATUSES = new Set(['released', 'refunded', 'withdrawn']);
const RELEASE_TARGET_STATUSES = new Set(['in_settlement', 'released', 'refunded', 'withdrawn']);
const RECON_EVENT_TYPES = new Set([
  'snapshot_recorded',
  'reserved',
  'in_settlement',
  'released',
  'refunded',
  'withdrawn',
  'reservation_conflict',
  'not_available'
]);

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

function parsePositiveInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return n;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
  store.state.liquidity_inventory_snapshots ||= {};
  store.state.liquidity_inventory_assets ||= {};
  store.state.liquidity_inventory_reservations ||= {};
  store.state.liquidity_inventory_reconciliation_events ||= [];
  store.state.liquidity_inventory_snapshot_counter ||= 0;
  store.state.liquidity_inventory_reservation_counter ||= 0;
  store.state.liquidity_inventory_reconciliation_counter ||= 0;
}

function nextSnapshotId(store) {
  store.state.liquidity_inventory_snapshot_counter += 1;
  return `lpinv_snapshot_${String(store.state.liquidity_inventory_snapshot_counter).padStart(6, '0')}`;
}

function nextReservationId(store) {
  store.state.liquidity_inventory_reservation_counter += 1;
  return `lpinv_res_${String(store.state.liquidity_inventory_reservation_counter).padStart(6, '0')}`;
}

function nextReconciliationEntryId(store) {
  store.state.liquidity_inventory_reconciliation_counter += 1;
  return `lpinv_evt_${String(store.state.liquidity_inventory_reconciliation_counter).padStart(6, '0')}`;
}

function holdingIdFor({ platform, assetId }) {
  return `${platform}:${assetId}`;
}

function reservationView(reservation) {
  return {
    reservation_id: reservation.reservation_id,
    provider_id: reservation.provider_id,
    holding_id: reservation.holding_id,
    asset_id: reservation.asset_id,
    platform: reservation.platform,
    quantity: reservation.quantity,
    cycle_id: reservation.cycle_id,
    context_ref: reservation.context_ref ?? null,
    status: reservation.status,
    owner_actor: clone(reservation.owner_actor),
    created_at: reservation.created_at,
    updated_at: reservation.updated_at,
    released_at: reservation.released_at ?? null
  };
}

function assetView(asset) {
  return {
    holding_id: asset.holding_id,
    asset_id: asset.asset_id,
    platform: asset.platform,
    total_quantity: asset.total_quantity,
    metadata: clone(asset.metadata ?? {}),
    snapshot_id: asset.snapshot_id,
    captured_at: asset.captured_at
  };
}

function reconciliationEntryView(entry) {
  return {
    entry_id: entry.entry_id,
    provider_id: entry.provider_id,
    occurred_at: entry.occurred_at,
    event_type: entry.event_type,
    holding_id: entry.holding_id,
    asset_id: entry.asset_id,
    quantity: entry.quantity,
    reservation_id: entry.reservation_id ?? null,
    cycle_id: entry.cycle_id ?? null,
    snapshot_id: entry.snapshot_id ?? null,
    status_from: entry.status_from ?? null,
    status_to: entry.status_to ?? null,
    owner_actor: clone(entry.owner_actor),
    details: clone(entry.details ?? {})
  };
}

function providerOwnerMismatch(actor, provider) {
  return actor?.type !== provider?.owner_actor?.type || actor?.id !== provider?.owner_actor?.id;
}

function activeStatus(status) {
  return ACTIVE_RESERVATION_STATUSES.has(status);
}

function terminalStatus(status) {
  return TERMINAL_RESERVATION_STATUSES.has(status);
}

export class LiquidityInventoryService {
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
      body: errorResponse(corr, 'FORBIDDEN', 'only partner actors are allowed for liquidity inventory operations', {
        operation_id: operationId,
        reason_code: 'liquidity_provider_actor_mismatch',
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

  _resolveProviderForActor({ actor, providerId, correlationId: corr }) {
    const normalizedProviderId = normalizeOptionalString(providerId);
    if (!normalizedProviderId) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'provider_id is required', {
          reason_code: 'liquidity_inventory_snapshot_invalid'
        })
      };
    }

    const provider = this.store.state.liquidity_providers?.[normalizedProviderId];
    if (!provider) {
      return {
        ok: false,
        body: errorResponse(corr, 'NOT_FOUND', 'liquidity provider not found', {
          reason_code: 'liquidity_provider_not_found',
          provider_id: normalizedProviderId
        })
      };
    }

    if (providerOwnerMismatch(actor, provider)) {
      return {
        ok: false,
        body: errorResponse(corr, 'FORBIDDEN', 'liquidity provider ownership mismatch', {
          reason_code: 'liquidity_provider_actor_mismatch',
          provider_id: normalizedProviderId,
          actor,
          owner_actor: provider.owner_actor
        })
      };
    }

    return { ok: true, provider_id: normalizedProviderId, provider };
  }

  _providerAssets(providerId) {
    this.store.state.liquidity_inventory_assets[providerId] ||= {};
    return this.store.state.liquidity_inventory_assets[providerId];
  }

  _providerSnapshots(providerId) {
    this.store.state.liquidity_inventory_snapshots[providerId] ||= [];
    return this.store.state.liquidity_inventory_snapshots[providerId];
  }

  _providerReservations(providerId) {
    return Object.values(this.store.state.liquidity_inventory_reservations ?? {}).filter(row => row?.provider_id === providerId);
  }

  _activeReservationByHolding(providerId) {
    const out = new Map();
    for (const row of this._providerReservations(providerId)) {
      if (!activeStatus(row.status)) continue;
      out.set(row.holding_id, row);
    }
    return out;
  }

  _reservationById(reservationId) {
    return this.store.state.liquidity_inventory_reservations?.[reservationId] ?? null;
  }

  _recordReconciliationEvent({
    providerId,
    occurredAt,
    eventType,
    holdingId,
    assetId,
    quantity,
    ownerActor,
    reservationId = null,
    cycleId = null,
    snapshotId = null,
    statusFrom = null,
    statusTo = null,
    details = {}
  }) {
    if (!RECON_EVENT_TYPES.has(eventType)) return;
    this.store.state.liquidity_inventory_reconciliation_events.push({
      entry_id: nextReconciliationEntryId(this.store),
      provider_id: providerId,
      occurred_at: occurredAt,
      event_type: eventType,
      holding_id: holdingId,
      asset_id: assetId,
      quantity,
      reservation_id: reservationId,
      cycle_id: cycleId,
      snapshot_id: snapshotId,
      status_from: statusFrom,
      status_to: statusTo,
      owner_actor: clone(ownerActor),
      details: isObject(details) ? clone(details) : {}
    });
  }

  _findAssetRecord({ providerId, holdingId, assetId, platform }) {
    const assetsByHolding = this._providerAssets(providerId);
    if (holdingId) {
      return assetsByHolding[holdingId] ?? null;
    }

    const key = holdingIdFor({ platform, assetId });
    return assetsByHolding[key] ?? null;
  }

  recordSnapshot({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityInventory.snapshot.record';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request },
      correlationId: corr,
      handler: () => {
        const snapshotReq = request?.snapshot;
        if (!isObject(snapshotReq)) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory snapshot payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid'
            })
          };
        }

        const platform = normalizeOptionalString(snapshotReq.platform);
        const capturedAt = normalizeOptionalString(snapshotReq.captured_at);
        const capturedMs = parseIsoMs(capturedAt);
        const assetsReq = Array.isArray(snapshotReq.assets) ? snapshotReq.assets : null;

        if (!platform || capturedMs === null || !assetsReq || assetsReq.length < 1) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory snapshot payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid'
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory snapshot payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const normalizedAssets = [];
        for (const item of assetsReq) {
          const assetId = normalizeOptionalString(item?.asset_id);
          const quantity = parsePositiveInt(item?.quantity);
          const metadata = isObject(item?.metadata) ? item.metadata : {};
          const requestHoldingId = normalizeOptionalString(item?.holding_id);
          const resolvedHoldingId = requestHoldingId ?? holdingIdFor({ platform, assetId: assetId ?? '' });

          if (!assetId || !quantity || !resolvedHoldingId) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory snapshot payload', {
                reason_code: 'liquidity_inventory_snapshot_invalid'
              })
            };
          }

          normalizedAssets.push({
            holding_id: resolvedHoldingId,
            asset_id: assetId,
            quantity,
            metadata
          });
        }

        const snapshotId = normalizeOptionalString(snapshotReq.snapshot_id) ?? nextSnapshotId(this.store);
        const snapshot = {
          snapshot_id: snapshotId,
          provider_id: resolvedProvider.provider_id,
          platform,
          captured_at: new Date(capturedMs).toISOString(),
          recorded_at: recordedAt,
          assets: normalizedAssets
        };

        const snapshots = this._providerSnapshots(resolvedProvider.provider_id);
        snapshots.push(snapshot);

        const assetsByHolding = this._providerAssets(resolvedProvider.provider_id);
        for (const asset of normalizedAssets) {
          assetsByHolding[asset.holding_id] = {
            provider_id: resolvedProvider.provider_id,
            holding_id: asset.holding_id,
            asset_id: asset.asset_id,
            platform,
            total_quantity: asset.quantity,
            metadata: clone(asset.metadata),
            snapshot_id: snapshot.snapshot_id,
            captured_at: snapshot.captured_at,
            recorded_at: snapshot.recorded_at
          };

          this._recordReconciliationEvent({
            providerId: resolvedProvider.provider_id,
            occurredAt: recordedAt,
            eventType: 'snapshot_recorded',
            holdingId: asset.holding_id,
            assetId: asset.asset_id,
            quantity: asset.quantity,
            ownerActor: resolvedProvider.provider.owner_actor,
            snapshotId: snapshot.snapshot_id,
            details: {
              platform
            }
          });
        }

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            snapshot: clone(snapshot)
          }
        };
      }
    });
  }

  listAssets({ actor, auth, providerId, query }) {
    const op = 'liquidityInventory.assets.list';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowed = new Set(['platform']);
    const unknown = Object.keys(query ?? {}).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory assets query', {
          reason_code: 'liquidity_inventory_snapshot_invalid',
          unknown_query_params: unknown.sort()
        })
      };
    }

    const platformFilter = normalizeOptionalString(query?.platform);
    const assets = Object.values(this._providerAssets(resolvedProvider.provider_id))
      .filter(asset => !platformFilter || asset.platform === platformFilter)
      .map(assetView)
      .sort((a, b) => String(a.holding_id).localeCompare(String(b.holding_id)));

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        assets
      }
    };
  }

  getAvailability({ actor, auth, providerId, query }) {
    const op = 'liquidityInventory.availability.get';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowed = new Set(['platform', 'asset_id']);
    const unknown = Object.keys(query ?? {}).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory availability query', {
          reason_code: 'liquidity_inventory_snapshot_invalid',
          unknown_query_params: unknown.sort()
        })
      };
    }

    const platformFilter = normalizeOptionalString(query?.platform);
    const assetIdFilter = normalizeOptionalString(query?.asset_id);
    const activeByHolding = this._activeReservationByHolding(resolvedProvider.provider_id);

    const assets = [];
    for (const asset of Object.values(this._providerAssets(resolvedProvider.provider_id))) {
      if (platformFilter && asset.platform !== platformFilter) continue;
      if (assetIdFilter && asset.asset_id !== assetIdFilter) continue;

      const activeReservation = activeByHolding.get(asset.holding_id) ?? null;
      const reservedQuantity = activeReservation?.status === 'reserved' ? activeReservation.quantity : 0;
      const inSettlementQuantity = activeReservation?.status === 'in_settlement' ? activeReservation.quantity : 0;
      const availableQuantity = Math.max(asset.total_quantity - reservedQuantity - inSettlementQuantity, 0);

      let status = 'available';
      if (inSettlementQuantity > 0) status = 'in_settlement';
      else if (reservedQuantity > 0) status = 'reserved';
      else if (availableQuantity < 1) status = 'not_available';

      assets.push({
        holding_id: asset.holding_id,
        asset_id: asset.asset_id,
        platform: asset.platform,
        total_quantity: asset.total_quantity,
        available_quantity: availableQuantity,
        reserved_quantity: reservedQuantity,
        in_settlement_quantity: inSettlementQuantity,
        active_reservation_id: activeReservation?.reservation_id ?? null,
        status,
        snapshot_id: asset.snapshot_id,
        captured_at: asset.captured_at
      });
    }

    assets.sort((a, b) => String(a.holding_id).localeCompare(String(b.holding_id)));

    const summary = {
      assets_count: assets.length,
      available_assets_count: assets.filter(asset => asset.status === 'available').length,
      reserved_assets_count: assets.filter(asset => asset.status === 'reserved').length,
      in_settlement_assets_count: assets.filter(asset => asset.status === 'in_settlement').length,
      not_available_assets_count: assets.filter(asset => asset.status === 'not_available').length
    };

    return {
      ok: true,
      body: {
        correlation_id: corr,
        provider_id: resolvedProvider.provider_id,
        assets,
        summary
      }
    };
  }

  reserveBatch({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityInventory.reserve.batch';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request },
      correlationId: corr,
      handler: () => {
        const reservationsReq = Array.isArray(request?.reservations) ? request.reservations : null;
        if (!reservationsReq || reservationsReq.length < 1) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reserve payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid'
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reserve payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const outcomes = [];
        const activeByHolding = this._activeReservationByHolding(resolvedProvider.provider_id);
        const reservationsState = this.store.state.liquidity_inventory_reservations;
        const assetsByHolding = this._providerAssets(resolvedProvider.provider_id);

        for (let i = 0; i < reservationsReq.length; i += 1) {
          const item = reservationsReq[i];
          const assetId = normalizeOptionalString(item?.asset_id);
          const cycleId = normalizeOptionalString(item?.cycle_id);
          const quantity = parsePositiveInt(item?.quantity);
          const platform = normalizeOptionalString(item?.platform) ?? 'steam';
          const requestedHoldingId = normalizeOptionalString(item?.holding_id);
          const reservationId = normalizeOptionalString(item?.reservation_id) ?? nextReservationId(this.store);
          const contextRef = normalizeOptionalString(item?.context_ref);

          if (!assetId || !cycleId || !quantity) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reserve payload', {
                reason_code: 'liquidity_inventory_snapshot_invalid'
              })
            };
          }

          const holdingId = requestedHoldingId ?? holdingIdFor({ platform, assetId });
          const asset = assetsByHolding[holdingId] ?? null;
          if (!asset) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_asset_not_found',
              reservation: null
            });
            continue;
          }

          if (asset.asset_id !== assetId || asset.platform !== platform) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_context_mismatch',
              reservation: null
            });
            continue;
          }

          const activeReservation = activeByHolding.get(holdingId) ?? null;
          if (activeReservation && activeReservation.reservation_id !== reservationId) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_conflict',
              reservation: null
            });

            this._recordReconciliationEvent({
              providerId: resolvedProvider.provider_id,
              occurredAt: recordedAt,
              eventType: 'reservation_conflict',
              holdingId,
              assetId,
              quantity,
              ownerActor: resolvedProvider.provider.owner_actor,
              cycleId,
              reservationId: activeReservation.reservation_id,
              statusFrom: activeReservation.status,
              statusTo: activeReservation.status,
              details: {
                requested_reservation_id: reservationId
              }
            });
            continue;
          }

          const availableQuantity = Math.max(asset.total_quantity - (activeReservation?.quantity ?? 0), 0);
          if (quantity > availableQuantity) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_not_available',
              reservation: null
            });

            this._recordReconciliationEvent({
              providerId: resolvedProvider.provider_id,
              occurredAt: recordedAt,
              eventType: 'not_available',
              holdingId,
              assetId,
              quantity,
              ownerActor: resolvedProvider.provider.owner_actor,
              cycleId,
              statusFrom: activeReservation?.status ?? 'available',
              statusTo: activeReservation?.status ?? 'available',
              details: {
                available_quantity: availableQuantity
              }
            });
            continue;
          }

          const existingReservation = this._reservationById(reservationId);
          if (existingReservation && existingReservation.provider_id !== resolvedProvider.provider_id) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_context_mismatch',
              reservation: null
            });
            continue;
          }

          if (existingReservation && existingReservation.holding_id !== holdingId) {
            outcomes.push({
              request_index: i,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_context_mismatch',
              reservation: null
            });
            continue;
          }

          const nextReservation = existingReservation
            ? {
                ...existingReservation,
                quantity,
                cycle_id: cycleId,
                context_ref: contextRef,
                status: 'reserved',
                updated_at: recordedAt,
                released_at: null
              }
            : {
                reservation_id: reservationId,
                provider_id: resolvedProvider.provider_id,
                holding_id: holdingId,
                asset_id: assetId,
                platform,
                quantity,
                cycle_id: cycleId,
                context_ref: contextRef,
                status: 'reserved',
                owner_actor: clone(resolvedProvider.provider.owner_actor),
                created_at: recordedAt,
                updated_at: recordedAt,
                released_at: null
              };

          reservationsState[reservationId] = nextReservation;
          activeByHolding.set(holdingId, nextReservation);

          this._recordReconciliationEvent({
            providerId: resolvedProvider.provider_id,
            occurredAt: recordedAt,
            eventType: 'reserved',
            holdingId,
            assetId,
            quantity,
            ownerActor: resolvedProvider.provider.owner_actor,
            reservationId,
            cycleId,
            statusFrom: existingReservation?.status ?? 'available',
            statusTo: 'reserved'
          });

          outcomes.push({
            request_index: i,
            ok: true,
            reason_code: null,
            reservation: reservationView(nextReservation)
          });
        }

        const summary = {
          requested_count: outcomes.length,
          success_count: outcomes.filter(row => row.ok).length,
          conflict_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_reservation_conflict').length,
          not_available_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_not_available').length,
          context_mismatch_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_reservation_context_mismatch').length,
          asset_not_found_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_asset_not_found').length,
          active_reservations_count: this._providerReservations(resolvedProvider.provider_id).filter(row => activeStatus(row.status)).length
        };

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            outcomes,
            summary
          }
        };
      }
    });
  }

  releaseBatch({ actor, auth, providerId, idempotencyKey, request }) {
    const op = 'liquidityInventory.release.batch';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { replayed: false, result: { ok: false, body: authz.body } };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return { replayed: false, result: partnerGuard };

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { replayed: false, result: { ok: false, body: resolvedProvider.body } };

    return this._withIdempotency({
      actor,
      operationId: op,
      idempotencyKey,
      requestBody: { provider_id: resolvedProvider.provider_id, request },
      correlationId: corr,
      handler: () => {
        const releasesReq = Array.isArray(request?.releases) ? request.releases : null;
        if (!releasesReq || releasesReq.length < 1) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory release payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid'
            })
          };
        }

        const recordedAt = normalizeOptionalString(request?.recorded_at) ?? this._nowIso(auth);
        if (parseIsoMs(recordedAt) === null) {
          return {
            ok: false,
            body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory release payload', {
              reason_code: 'liquidity_inventory_snapshot_invalid',
              recorded_at: request?.recorded_at ?? null
            })
          };
        }

        const outcomes = [];
        const reservationsState = this.store.state.liquidity_inventory_reservations;

        for (let i = 0; i < releasesReq.length; i += 1) {
          const item = releasesReq[i];
          const reservationId = normalizeOptionalString(item?.reservation_id);
          const targetStatus = normalizeOptionalString(item?.target_status);
          const cycleId = normalizeOptionalString(item?.cycle_id);
          const holdingId = normalizeOptionalString(item?.holding_id);

          if (!reservationId || !targetStatus || !RELEASE_TARGET_STATUSES.has(targetStatus)) {
            return {
              ok: false,
              body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory release payload', {
                reason_code: 'liquidity_inventory_snapshot_invalid'
              })
            };
          }

          const reservation = reservationsState[reservationId] ?? null;
          if (!reservation || reservation.provider_id !== resolvedProvider.provider_id) {
            outcomes.push({
              request_index: i,
              reservation_id: reservationId,
              ok: false,
              reason_code: 'liquidity_inventory_asset_not_found',
              previous_status: null,
              status: null,
              reservation: null
            });
            continue;
          }

          if (cycleId && reservation.cycle_id !== cycleId) {
            outcomes.push({
              request_index: i,
              reservation_id: reservationId,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_context_mismatch',
              previous_status: reservation.status,
              status: reservation.status,
              reservation: reservationView(reservation)
            });
            continue;
          }

          if (holdingId && reservation.holding_id !== holdingId) {
            outcomes.push({
              request_index: i,
              reservation_id: reservationId,
              ok: false,
              reason_code: 'liquidity_inventory_reservation_context_mismatch',
              previous_status: reservation.status,
              status: reservation.status,
              reservation: reservationView(reservation)
            });
            continue;
          }

          const priorStatus = reservation.status;
          if (priorStatus !== targetStatus) {
            const reservedTransition = priorStatus === 'reserved' && RELEASE_TARGET_STATUSES.has(targetStatus);
            const inSettlementTransition = priorStatus === 'in_settlement' && TERMINAL_RESERVATION_STATUSES.has(targetStatus);
            if (!reservedTransition && !inSettlementTransition) {
              outcomes.push({
                request_index: i,
                reservation_id: reservationId,
                ok: false,
                reason_code: 'liquidity_inventory_reservation_context_mismatch',
                previous_status: priorStatus,
                status: priorStatus,
                reservation: reservationView(reservation)
              });
              continue;
            }
          }

          reservation.status = targetStatus;
          reservation.updated_at = recordedAt;
          reservation.released_at = terminalStatus(targetStatus) ? recordedAt : null;

          this._recordReconciliationEvent({
            providerId: resolvedProvider.provider_id,
            occurredAt: recordedAt,
            eventType: targetStatus,
            holdingId: reservation.holding_id,
            assetId: reservation.asset_id,
            quantity: reservation.quantity,
            ownerActor: reservation.owner_actor,
            reservationId: reservation.reservation_id,
            cycleId: reservation.cycle_id,
            statusFrom: priorStatus,
            statusTo: targetStatus
          });

          outcomes.push({
            request_index: i,
            reservation_id: reservationId,
            ok: true,
            reason_code: null,
            previous_status: priorStatus,
            status: reservation.status,
            reservation: reservationView(reservation)
          });
        }

        const summary = {
          requested_count: outcomes.length,
          success_count: outcomes.filter(row => row.ok).length,
          context_mismatch_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_reservation_context_mismatch').length,
          asset_not_found_count: outcomes.filter(row => row.reason_code === 'liquidity_inventory_asset_not_found').length,
          active_reservations_count: this._providerReservations(resolvedProvider.provider_id).filter(row => activeStatus(row.status)).length
        };

        return {
          ok: true,
          body: {
            correlation_id: corr,
            provider_id: resolvedProvider.provider_id,
            outcomes,
            summary
          }
        };
      }
    });
  }

  exportReconciliation({ actor, auth, providerId, query }) {
    const op = 'liquidityInventory.reconciliation.export';
    const corr = correlationId(op);

    const authz = this._authorize({ actor, auth, operationId: op, correlationId: corr });
    if (!authz.ok) return { ok: false, body: authz.body };

    const partnerGuard = this._requirePartner({ actor, operationId: op, correlationId: corr });
    if (partnerGuard) return partnerGuard;

    const resolvedProvider = this._resolveProviderForActor({ actor, providerId, correlationId: corr });
    if (!resolvedProvider.ok) return { ok: false, body: resolvedProvider.body };

    const allowed = new Set(['limit', 'cursor_after', 'event_type']);
    const unknown = Object.keys(query ?? {}).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reconciliation export query', {
          reason_code: 'liquidity_inventory_reconciliation_query_invalid',
          unknown_query_params: unknown.sort()
        })
      };
    }

    const limit = parseLimit(query?.limit, 50);
    if (limit === null) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reconciliation export query', {
          reason_code: 'liquidity_inventory_reconciliation_query_invalid',
          limit: query?.limit ?? null
        })
      };
    }

    const cursorAfter = normalizeOptionalString(query?.cursor_after);
    const eventType = normalizeOptionalString(query?.event_type);
    if (eventType && !RECON_EVENT_TYPES.has(eventType)) {
      return {
        ok: false,
        body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reconciliation export query', {
          reason_code: 'liquidity_inventory_reconciliation_query_invalid',
          event_type: eventType
        })
      };
    }

    const entries = (this.store.state.liquidity_inventory_reconciliation_events ?? [])
      .filter(entry => entry?.provider_id === resolvedProvider.provider_id)
      .filter(entry => !eventType || entry?.event_type === eventType)
      .map(reconciliationEntryView)
      .sort((a, b) => String(a.entry_id).localeCompare(String(b.entry_id)));

    let start = 0;
    if (cursorAfter) {
      const idx = entries.findIndex(entry => entry.entry_id === cursorAfter);
      if (idx < 0) {
        return {
          ok: false,
          body: errorResponse(corr, 'CONSTRAINT_VIOLATION', 'invalid liquidity inventory reconciliation export query', {
            reason_code: 'liquidity_inventory_reconciliation_query_invalid',
            cursor_after: cursorAfter
          })
        };
      }
      start = idx + 1;
    }

    const page = entries.slice(start, start + limit);
    const hasMore = start + page.length < entries.length;
    const nextCursor = hasMore ? page[page.length - 1]?.entry_id ?? null : null;

    const signedExport = buildSignedPolicyAuditExportPayload({
      exportedAt: this._nowIso(auth),
      query: {
        provider_id: resolvedProvider.provider_id,
        limit,
        ...(cursorAfter ? { cursor_after: cursorAfter } : {}),
        ...(eventType ? { event_type: eventType } : {})
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
        provider_id: resolvedProvider.provider_id,
        export: signedExport
      }
    };
  }
}
