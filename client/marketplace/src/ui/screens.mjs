import {
  composerMaxCycleLengthOptions,
  composerValueToleranceOptions,
  composerWearOptions,
  defaultComposerDraft
} from '../features/intents/composer.mjs';
import { buildActiveTimelineModel } from '../features/active/timeline.mjs';
import { buildProposalDetailModel, rankInboxCards } from '../features/inbox/proposals.mjs';
import { watchStateForIntent, proposalCountsByIntent } from '../features/intents/watchState.mjs';
import { buildItemCards, demandBannerModel, humanizeAssetId } from '../features/items/cards.mjs';
import { quietHoursLabel } from '../features/notifications/preferences.mjs';
import { panelA11yId, tabA11yId } from '../features/accessibility/tabs.mjs';
import { clampListForRender } from '../features/performance/listBudget.mjs';
import { actorDisplayLabel } from '../pilot/trackATheme.mjs';
import { escapeHtml, formatIsoShort, formatUsd, toneFromState } from '../utils/format.mjs';

function shellCard(title, body, footer = '') {
  return `
    <article class="card">
      <h3 class="u-text-md u-weight-600">${escapeHtml(title)}</h3>
      <p class="u-text-base u-ink-2">${body}</p>
      ${footer ? `<div class="card-foot">${footer}</div>` : ''}
    </article>
  `;
}

function readIntentWantLabel(intent) {
  const clause = intent?.wantSpec?.anyOf?.[0] ?? null;
  if (!clause) return 'Any tradable item';
  if (clause.type === 'category') return clause.category || 'Category target';
  if (clause.type === 'specific_asset') return clause.assetKey || 'Specific asset';
  return 'Any tradable item';
}

function readTolerance(intent) {
  const min = Number(intent?.valueBand?.minUsd ?? 0);
  const max = Number(intent?.valueBand?.maxUsd ?? 0);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return Math.max(0, Math.round((max - min) / 2));
}

function renderDemandBanner(projection) {
  const banner = demandBannerModel(projection);
  if (!banner.visible) return '';
  return `
    <button
      type="button"
      class="demand-banner"
      data-action="items.openInbox"
      aria-label="Open inbox proposals"
    >
      <span class="demand-dot" aria-hidden="true"></span>
      <span class="u-text-base"><strong>${escapeHtml(String(banner.opportunityCount))} proposals</strong> matched your intents</span>
      <span class="demand-arrow" aria-hidden="true">→</span>
    </button>
  `;
}

function renderItemsSort(sort) {
  const activeSort = sort === 'also_tradable' ? 'also_tradable' : 'highest_demand';
  const options = [
    { id: 'highest_demand', label: 'Highest demand' },
    { id: 'also_tradable', label: 'Also tradable' }
  ];

  return `
    <div class="sort-row" role="group" aria-label="Item sorting">
      ${options.map(option => `
        <button
          type="button"
          class="sort-btn${activeSort === option.id ? ' is-active' : ''}"
          data-action="items.sort"
          data-sort="${option.id}"
          aria-pressed="${activeSort === option.id ? 'true' : 'false'}"
        >
          ${escapeHtml(option.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderItemsCards(state) {
  const intents = state?.caches?.intents?.items ?? [];
  const projection = state?.caches?.inventoryAwakening?.value ?? null;
  const sort = state?.ui?.itemsSort ?? 'highest_demand';
  const itemModel = buildItemCards({ intents, projection, sort });

  if (itemModel.cards.length === 0) {
    return shellCard(
      'No tradable cards yet',
      'Post your first intent to populate inventory demand cards and start continuous matching.',
      '<button type="button" class="inline-action" data-action="composer.open">Post first intent</button>'
    );
  }

  return `
    <section class="items-grid" aria-label="Tradable inventory cards">
      ${itemModel.cards.map(card => `
        <article class="item-card">
          <div class="item-card-top">
            <span class="pill ${card.demandCount > 0 ? 'tone-signal' : 'tone-neutral'}">${escapeHtml(String(card.demandCount))} wants</span>
            <span class="wear-badge">${escapeHtml(card.wear || 'n/a')}</span>
          </div>
          <h3 class="u-text-md u-weight-600">${escapeHtml(card.name)}</h3>
          <div class="item-meta">
            <span class="u-text-data">${escapeHtml(formatUsd(card.priceUsd))}</span>
            <span class="u-text-sm u-ink-3">${escapeHtml(String(card.intentCount))} intent${card.intentCount === 1 ? '' : 's'}</span>
          </div>
          <p class="u-text-sm u-ink-3">${card.kind === 'highest_demand' ? 'Highest demand' : 'Also tradable'}</p>
        </article>
      `).join('')}
    </section>
  `;
}

function renderItems(state) {
  const projection = state?.caches?.inventoryAwakening?.value ?? null;
  const summary = projection?.swappabilitySummary ?? null;
  const notificationPrefs = state?.ui?.notificationPrefs?.values ?? null;
  const channelCount = Number(notificationPrefs?.channels?.proposal === true)
    + Number(notificationPrefs?.channels?.active === true)
    + Number(notificationPrefs?.channels?.receipt === true);

  const summaryLine = summary
    ? `<p class="u-text-base u-ink-2">Active intents <span class="u-text-data">${escapeHtml(String(summary.activeIntents))}</span> · Cycle opportunities <span class="u-text-data">${escapeHtml(String(summary.cycleOpportunities))}</span> · Avg confidence <span class="u-text-data">${escapeHtml(String(summary.averageConfidenceBps))}</span> bps</p>`
    : '<p class="u-text-base u-ink-2">Inventory awakening data is loading. Demand cards update as intent and proposal signals arrive.</p>';

  return `
    <section class="screen-block">
      <p class="u-cap">Items</p>
      <h2 class="u-display">Inventory Awakening</h2>
      ${summaryLine}
      ${renderDemandBanner(projection)}
      <article class="card">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Notification controls</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(String(channelCount))} channels on</span>
        </div>
        <p class="u-text-base u-ink-2">Quiet hours: <span class="u-text-data">${escapeHtml(quietHoursLabel(notificationPrefs))}</span></p>
        <p class="u-text-base u-ink-2">Proposal, Active, and Receipt alerts can be tuned without affecting matching itself.</p>
        <div class="card-foot">
          <button type="button" class="inline-action" data-action="notifications.openPrefs">Adjust alerts</button>
        </div>
      </article>
      ${renderItemsSort(state?.ui?.itemsSort)}
      ${renderItemsCards(state)}
    </section>
  `;
}

function renderIntentTags(intent) {
  const tolerance = readTolerance(intent);
  const cycleLength = Number(intent?.trustConstraints?.maxCycleLength ?? 0);
  const tags = [];
  if (Number.isFinite(tolerance) && tolerance > 0) tags.push(`± $${tolerance}`);
  if (Number.isFinite(cycleLength) && cycleLength > 0) tags.push(`≤ ${cycleLength} hops`);
  if (intent?.settlementPreferences?.requireEscrow === true) tags.push('escrow');

  if (tags.length === 0) return '';

  return `
    <div class="intent-tags">
      ${tags.map(tag => `<span class="itag">${escapeHtml(tag)}</span>`).join('')}
    </div>
  `;
}

function renderComposerValidation(errors, key) {
  const text = errors?.[key] ?? null;
  if (!text) return '';
  return `<p class="field-error u-text-sm">${escapeHtml(text)}</p>`;
}

function renderComposer(state) {
  const composerState = state?.ui?.composer ?? null;
  if (!composerState?.isOpen) return '';

  const mode = composerState.mode === 'edit' ? 'edit' : 'create';
  const draft = {
    ...defaultComposerDraft(),
    ...(composerState.draft ?? {})
  };
  const selectedWear = new Set(Array.isArray(draft.acceptableWear) ? draft.acceptableWear : []);
  const selectedTolerance = Number(draft.valueToleranceUsd ?? 50);
  const selectedCycleLength = Number(draft.maxCycleLength ?? 3);
  const errors = composerState.errors ?? {};

  return `
    <div class="composer-backdrop">
      <button type="button" class="composer-scrim" data-action="composer.close" aria-label="Close composer"></button>
      <section class="composer-sheet" role="dialog" aria-modal="true" aria-label="Intent composer">
        <div class="composer-head">
          <h3 class="u-text-md u-weight-600">${mode === 'edit' ? 'Edit intent' : 'Post new intent'}</h3>
          <button type="button" class="icon-btn" data-action="composer.close" aria-label="Close composer">×</button>
        </div>

        <form data-form="intent-composer" class="composer-form">
          <input type="hidden" name="mode" value="${escapeHtml(mode)}" />
          <div class="field">
            <label class="u-text-sm u-weight-600" for="composer-offering-asset">Offering asset id</label>
            <input
              id="composer-offering-asset"
              class="field-input"
              type="text"
              name="offering_asset_id"
              value="${escapeHtml(String(draft.offeringAssetId ?? ''))}"
              placeholder="e.g. ak47_vulcan_mw_1"
              autocomplete="off"
            />
            ${renderComposerValidation(errors, 'offeringAssetId')}
          </div>

          <div class="field">
            <label class="u-text-sm u-weight-600" for="composer-offer-value">Offer value (USD)</label>
            <input
              id="composer-offer-value"
              class="field-input"
              type="number"
              min="1"
              step="1"
              name="offer_value_usd"
              value="${escapeHtml(String(draft.offerValueUsd ?? 120))}"
              autocomplete="off"
            />
            ${renderComposerValidation(errors, 'offerValueUsd')}
          </div>

          <div class="field">
            <label class="u-text-sm u-weight-600" for="composer-want-category">Want target</label>
            <input
              id="composer-want-category"
              class="field-input"
              type="text"
              name="want_category"
              value="${escapeHtml(String(draft.wantCategory ?? ''))}"
              placeholder="e.g. any cs2 knife"
              autocomplete="off"
            />
            ${renderComposerValidation(errors, 'wantCategory')}
          </div>

          <div class="field">
            <p class="u-text-sm u-weight-600">Acceptable wear</p>
            <div class="choice-row">
              ${composerWearOptions().map(wear => `
                <label class="choice-chip">
                  <input
                    type="checkbox"
                    name="acceptable_wear"
                    value="${wear}"
                    ${selectedWear.has(wear) ? 'checked' : ''}
                  />
                  <span>${wear}</span>
                </label>
              `).join('')}
            </div>
            ${renderComposerValidation(errors, 'acceptableWear')}
          </div>

          <div class="field">
            <p class="u-text-sm u-weight-600">Value tolerance</p>
            <div class="choice-row">
              ${composerValueToleranceOptions().map(option => `
                <label class="choice-chip">
                  <input
                    type="radio"
                    name="value_tolerance_usd"
                    value="${option}"
                    ${selectedTolerance === option ? 'checked' : ''}
                  />
                  <span>± $${option}</span>
                </label>
              `).join('')}
            </div>
            ${renderComposerValidation(errors, 'valueToleranceUsd')}
          </div>

          <div class="field">
            <p class="u-text-sm u-weight-600">Max cycle length</p>
            <div class="choice-row">
              ${composerMaxCycleLengthOptions().map(option => `
                <label class="choice-chip">
                  <input
                    type="radio"
                    name="max_cycle_length"
                    value="${option}"
                    ${selectedCycleLength === option ? 'checked' : ''}
                  />
                  <span>${option}-way</span>
                </label>
              `).join('')}
            </div>
            ${renderComposerValidation(errors, 'maxCycleLength')}
          </div>

          <div class="field-actions">
            <button type="button" class="btn-inline" data-action="composer.close">Cancel</button>
            <button type="submit" class="btn-primary-inline" ${composerState.submitting ? 'disabled' : ''}>
              ${composerState.submitting ? 'Saving…' : (mode === 'edit' ? 'Save intent' : 'Post intent')}
            </button>
          </div>
        </form>
      </section>
    </div>
  `;
}

function renderIntents(state) {
  const intents = state?.caches?.intents?.items ?? [];
  const proposals = state?.caches?.proposals?.items ?? [];
  const counts = proposalCountsByIntent(proposals);

  const emptyState = intents.length === 0
    ? shellCard(
      'No standing intents',
      'Create a structured intent and the system keeps watching continuously.',
      '<button type="button" class="inline-action" data-action="composer.open">Post new intent</button>'
    )
    : `
      <section class="intent-list" aria-label="Standing intents">
        ${intents.map(intent => {
          const watch = watchStateForIntent(intent, counts.get(intent.id) ?? 0);
          const mutation = state?.ui?.intentMutations?.[intent.id] ?? null;
          const isMutating = mutation?.pending === true;
          const giveAsset = intent?.offer?.[0] ?? null;
          const giveName = giveAsset?.label || humanizeAssetId(giveAsset?.assetId);
          const wantLabel = readIntentWantLabel(intent);
          const watchCopy = `${watch.headline} · ${watch.detail}`;

          return `
            <article class="intent-card">
              <div class="intent-head">
                <p class="u-text-sm u-ink-3">Offering</p>
                <h3 class="u-text-md u-weight-600">${escapeHtml(giveName)}</h3>
                <p class="u-text-sm u-ink-3">Want</p>
                <p class="u-text-base">${escapeHtml(wantLabel)}</p>
              </div>
              ${renderIntentTags(intent)}
              <div class="intent-foot">
                <span class="pill tone-${escapeHtml(watch.tone)}">${escapeHtml(watchCopy)}</span>
                ${isMutating ? '<span class="u-text-sm u-ink-3">syncing…</span>' : ''}
              </div>
              <div class="intent-actions">
                <button
                  type="button"
                  class="inline-action"
                  data-action="composer.edit"
                  data-intent-id="${escapeHtml(intent.id)}"
                  ${isMutating || watch.kind === 'cancelled' ? 'disabled' : ''}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="inline-action danger"
                  data-action="intent.cancel"
                  data-intent-id="${escapeHtml(intent.id)}"
                  ${isMutating || watch.kind === 'cancelled' ? 'disabled' : ''}
                >
                  Cancel
                </button>
              </div>
            </article>
          `;
        }).join('')}
      </section>
    `;

  return `
    <section class="screen-block">
      <p class="u-cap">Intents</p>
      <h2 class="u-display">Standing Watch</h2>
      <p class="u-text-base u-ink-2">Create once, then the matcher keeps running. Watching and matched states stay explicit at all times.</p>
      <div class="intent-toolbar">
        <button type="button" class="btn-primary-inline" data-action="composer.open">+ Post new intent</button>
      </div>
      ${emptyState}
      ${renderComposer(state)}
    </section>
  `;
}

function toneForUrgency(urgencyKind) {
  if (urgencyKind === 'critical') return 'danger';
  if (urgencyKind === 'soon') return 'caution';
  return 'neutral';
}

function renderProposalSection(title, cards, state) {
  const clipped = clampListForRender(cards);
  if (clipped.totalCount === 0) return '';
  return `
    <section class="proposal-section" aria-label="${escapeHtml(title)}">
      <div class="proposal-section-head">
        <h3 class="u-text-md u-weight-600">${escapeHtml(title)}</h3>
        <span class="u-text-sm u-ink-3">${escapeHtml(String(clipped.totalCount))}</span>
      </div>
      <div class="proposal-list">
        ${clipped.rows.map(card => {
          const mutation = state?.ui?.proposalMutations?.[card.proposalId] ?? null;
          const statusLabel = mutation?.pending
            ? 'Decision pending…'
            : (mutation?.status ? `Decision: ${mutation.status}` : 'Tap to review');

          return `
            <button
              type="button"
              class="proposal-card"
              data-action="inbox.openProposal"
              data-proposal-id="${escapeHtml(card.proposalId)}"
              data-rank="${escapeHtml(String(card.rank))}"
              aria-label="Open proposal ${escapeHtml(card.proposalId)}"
            >
              <div class="proposal-row">
                <span class="u-cap">Give</span>
                <span class="proposal-item u-text-md u-weight-600">${escapeHtml(card.giveName)}</span>
                <span class="u-text-sm u-ink-3">${escapeHtml(card.giveMeta)}</span>
              </div>
              <div class="proposal-separator" aria-hidden="true"></div>
              <div class="proposal-row">
                <span class="u-cap">Get</span>
                <span class="proposal-item u-text-md u-weight-600">${escapeHtml(card.getName)}</span>
                <span class="u-text-sm u-ink-3">${escapeHtml(card.getMeta)}</span>
              </div>
              <div class="proposal-foot">
                <span class="pill tone-${escapeHtml(toneForUrgency(card.urgencyKind))}">${escapeHtml(card.urgencyLabel)}</span>
                <span class="pill tone-signal">${escapeHtml(String(card.confidencePercent))}% confidence</span>
                <span class="pill tone-neutral">${escapeHtml(card.valueDeltaLabel)}</span>
                <span class="u-text-sm u-ink-3">${escapeHtml(card.cycleType)}</span>
                <span class="u-text-sm u-ink-3">${escapeHtml(card.expiresAtLabel)}</span>
              </div>
              <p class="u-text-sm u-ink-3">${escapeHtml(statusLabel)}</p>
            </button>
          `;
        }).join('')}
      </div>
      ${clipped.truncatedCount > 0
    ? `<p class="u-text-sm u-ink-3">Showing first ${escapeHtml(String(clipped.rows.length))} cards for smooth scrolling. ${escapeHtml(String(clipped.truncatedCount))} more available.</p>`
    : ''}
    </section>
  `;
}

function renderInboxList(state) {
  const proposals = state?.caches?.proposals?.items ?? [];
  const intents = state?.caches?.intents?.items ?? [];
  const ranked = rankInboxCards({ proposals, intents });

  if (ranked.cards.length === 0) {
    return `
      <section class="screen-block">
        <p class="u-cap">Inbox</p>
        <h2 class="u-display">Proposal Inbox</h2>
        ${shellCard(
          'No active proposals',
          'The matcher is running continuously. New opportunities appear here as soon as they meet your constraints.',
          '<span class="pill tone-neutral">Watching for high-confidence cycles</span>'
        )}
      </section>
    `;
  }

  return `
    <section class="screen-block">
      <p class="u-cap">Inbox</p>
      <h2 class="u-display">Proposal Inbox</h2>
      <p class="u-text-base u-ink-2">Ranked by urgency, confidence, and expected value delta. Review the top cards first.</p>
      <p class="u-text-base u-ink-2">Open proposals: <span class="u-text-data">${escapeHtml(String(ranked.stats.totalCount))}</span> · Urgent: <span class="u-text-data">${escapeHtml(String(ranked.stats.urgentCount))}</span></p>
      ${renderProposalSection('Urgent decisions', ranked.sections.priority, state)}
      ${renderProposalSection('Ranked opportunities', ranked.sections.ranked, state)}
    </section>
  `;
}

function renderProposalDetail(state, proposalId) {
  const proposals = state?.caches?.proposals?.items ?? [];
  const intents = state?.caches?.intents?.items ?? [];
  const proposal = proposals.find(row => row?.id === proposalId) ?? null;

  if (!proposal) {
    return `
      <section class="screen-block">
        <p class="u-cap">Proposal Detail</p>
        <h2 class="u-display">Proposal not found</h2>
        ${shellCard(
          'Unavailable proposal',
          'This proposal may have expired or been replaced by a newer cycle.',
          '<button type="button" class="inline-action" data-action="proposal.backToInbox">Back to inbox</button>'
        )}
      </section>
    `;
  }

  const detail = buildProposalDetailModel({ proposal, intents });
  const mutation = state?.ui?.proposalMutations?.[proposalId] ?? null;
  const pendingDecision = mutation?.pending === true;
  const accepted = mutation?.status === 'accepted';
  const declined = mutation?.status === 'declined';

  const decisionStatus = mutation?.error
    ? `<span class="pill tone-danger">Decision failed: ${escapeHtml(mutation.error)}</span>`
    : (accepted || declined)
      ? `<span class="pill tone-signal">Decision recorded: ${escapeHtml(mutation.status)}</span>`
      : `<span class="pill tone-${escapeHtml(toneForUrgency(detail.card.urgencyKind))}">${escapeHtml(detail.urgencyLabel)}</span>`;

  return `
    <section class="screen-block">
      <p class="u-cap">Proposal Detail</p>
      <h2 class="u-display">Review cycle ${escapeHtml(detail.proposalId)}</h2>
      <div class="detail-top-actions">
        <button type="button" class="inline-action" data-action="proposal.backToInbox">Back to inbox</button>
        ${decisionStatus}
      </div>

      <section class="proposal-hero" aria-label="Exchange summary">
        <article class="hero-item">
          <p class="u-cap">Give</p>
          <h3 class="u-text-md u-weight-600">${escapeHtml(detail.hero.giveName)}</h3>
          <p class="u-text-sm u-ink-3">${escapeHtml(detail.hero.giveMeta)}</p>
        </article>
        <article class="hero-item">
          <p class="u-cap">Get</p>
          <h3 class="u-text-md u-weight-600">${escapeHtml(detail.hero.getName)}</h3>
          <p class="u-text-sm u-ink-3">${escapeHtml(detail.hero.getMeta)}</p>
        </article>
      </section>

      <section class="proposal-cycle" aria-label="Cycle context">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Cycle context</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(detail.cycleType)}</span>
        </div>
        <div class="cycle-graph">
          ${detail.cycleNodes.map((node, index) => `
            <div class="cycle-node${node.isUser ? ' is-user' : ''}">
              <p class="u-text-sm u-weight-600">${escapeHtml(node.actorLabel)}</p>
              <p class="u-text-sm u-ink-3">${escapeHtml(node.giveLabel)}</p>
            </div>
            ${index < detail.cycleNodes.length - 1 ? '<span class="cycle-arrow" aria-hidden="true">→</span>' : ''}
          `).join('')}
        </div>
      </section>

      <section class="proposal-explain" aria-label="Why this proposal">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Why this proposal</h3>
          <span class="u-text-sm u-ink-3">always-on explanation</span>
        </div>
        <div class="explain-grid">
          ${detail.explanationCards.map(card => `
            <article class="explain-card">
              <p class="u-text-sm u-weight-600">${escapeHtml(card.title)}</p>
              <p class="u-text-base u-ink-2">${escapeHtml(card.body)}</p>
            </article>
          `).join('')}
        </div>
      </section>

      <div class="proposal-actions">
        <button
          type="button"
          class="inline-action danger"
          data-action="proposal.decline"
          data-proposal-id="${escapeHtml(detail.proposalId)}"
          ${pendingDecision || accepted || declined ? 'disabled' : ''}
        >
          ${pendingDecision && mutation?.decision === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <button
          type="button"
          class="btn-primary-inline"
          data-action="proposal.accept"
          data-proposal-id="${escapeHtml(detail.proposalId)}"
          ${pendingDecision || accepted || declined ? 'disabled' : ''}
        >
          ${pendingDecision && mutation?.decision === 'accept' ? 'Accepting…' : 'Accept swap'}
        </button>
      </div>
    </section>
  `;
}

function renderInbox(state) {
  const proposalId = state?.route?.params?.proposalId ?? null;
  if (proposalId) return renderProposalDetail(state, proposalId);
  return renderInboxList(state);
}

function renderActive(state) {
  const cycleId = state?.route?.params?.cycleId ?? null;
  const timeline = cycleId ? state?.caches?.timeline?.[cycleId]?.value ?? null : null;
  const intents = state?.caches?.intents?.items ?? [];
  const model = buildActiveTimelineModel({
    timeline,
    intents,
    viewerActorIdHint: state?.session?.actorId ?? null
  });
  const activeMutation = cycleId ? state?.ui?.activeMutations?.[cycleId] ?? null : null;

  if (!cycleId) {
    return `
      <section class="screen-block">
        <p class="u-cap">Active</p>
        <h2 class="u-display">Settlement Timeline</h2>
        ${shellCard(
          'No active cycle selected',
          'Open <span class="u-text-data">#/active/cycle/{cycle_id}</span> to inspect an in-flight settlement with explicit next actions and wait reasons.',
          '<span class="pill tone-neutral">timeline clarity checkpoint</span>'
        )}
      </section>
    `;
  }

  if (!model) {
    return `
      <section class="screen-block">
        <p class="u-cap">Active</p>
        <h2 class="u-display">Settlement Timeline</h2>
        ${shellCard(
          'Timeline unavailable',
          `No timeline data is currently cached for cycle <span class="u-text-data">${escapeHtml(cycleId)}</span>.`,
          '<button type="button" class="inline-action" data-action="active.refreshCycle">Retry</button>'
        )}
      </section>
    `;
  }

  const tone = toneFromState(model.state);
  const actions = model.actions.map(action => {
    const isPending = activeMutation?.pending === true && activeMutation?.action === action.key;
    const isLatestAttempt = activeMutation?.pending === false && activeMutation?.action === action.key;
    const isBusy = activeMutation?.pending === true;
    const enabled = action.enabled && !isBusy;

    const pendingLabelByAction = {
      confirm_deposit: 'Confirming deposit...',
      begin_execution: 'Starting execution...',
      complete_settlement: 'Completing settlement...',
      open_receipt: 'Opening receipt...'
    };

    const label = isPending
      ? (pendingLabelByAction[action.key] ?? 'Working...')
      : action.label;

    let detail = action.enabled ? 'Available now.' : action.reason;
    if (isPending) detail = 'Submitting action...';
    if (isLatestAttempt && activeMutation?.error) detail = `Last attempt failed: ${activeMutation.error}`;
    if (isLatestAttempt && !activeMutation?.error) detail = 'Last attempt succeeded.';

    return {
      ...action,
      enabled,
      label,
      detail
    };
  });

  return `
    <section class="screen-block">
      <p class="u-cap">Active</p>
      <h2 class="u-display">Settlement Timeline</h2>
      <section class="active-status tone-${escapeHtml(tone)}">
        <div class="active-status-head">
          <span class="active-dot" aria-hidden="true"></span>
          <div>
            <p class="u-text-sm u-ink-3">Cycle <span class="u-text-data">${escapeHtml(model.cycleId)}</span></p>
            <h3 class="u-text-md u-weight-600">${escapeHtml(model.statusHeadline)}</h3>
            <p class="u-text-base u-ink-2">${escapeHtml(model.statusDetail)}</p>
          </div>
          <span class="pill tone-${escapeHtml(tone)}">${escapeHtml(model.state)}</span>
        </div>
        <div class="active-progress" aria-label="Settlement progress">
          <div class="active-progress-bar"><span style="width:${escapeHtml(String(model.progressPercent))}%"></span></div>
          <div class="active-progress-meta">
            <span class="u-text-sm u-ink-3">${escapeHtml(model.progressLabel)}</span>
            <span class="u-text-sm u-ink-3">Updated ${escapeHtml(model.updatedAtLabel)}</span>
          </div>
        </div>
        ${model.deadlineAt ? `<p class="u-text-sm u-ink-3">Deadline ${escapeHtml(model.deadlineLabel)}</p>` : ''}
      </section>

      <section class="active-actions" aria-label="Settlement actions">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Next actions</h3>
          <span class="u-text-sm u-ink-3">state-aware controls</span>
        </div>
        ${actions.map(action => `
          <div class="active-action-row">
            <button
              type="button"
              class="${action.key === 'confirm_deposit' || action.key === 'open_receipt' ? 'btn-primary-inline' : 'inline-action'}"
              data-action="${escapeHtml(action.eventType)}"
              data-cycle-id="${escapeHtml(model.cycleId)}"
              data-action-key="${escapeHtml(action.key)}"
              ${action.enabled ? '' : 'disabled'}
            >
              ${escapeHtml(action.label)}
            </button>
            <p class="u-text-sm u-ink-3">${escapeHtml(action.detail)}</p>
          </div>
        `).join('')}
      </section>

      <section class="active-timeline" aria-label="Settlement events">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Timeline events</h3>
          <span class="u-text-sm u-ink-3">explicit wait reasons</span>
        </div>
        <div class="active-event-list">
          ${model.entries.map(entry => `
            <article class="active-event is-${escapeHtml(entry.kind)}">
              <span class="active-event-dot" aria-hidden="true"></span>
              <div>
                <p class="u-text-sm u-weight-600">${escapeHtml(entry.title)}</p>
                <p class="u-text-base u-ink-2">${escapeHtml(entry.detail)}</p>
                <p class="u-text-sm u-ink-3">${escapeHtml(formatIsoShort(entry.timestamp))}</p>
              </div>
            </article>
          `).join('')}
        </div>
      </section>
    </section>
  `;
}

function receiptReasonCode(receipt) {
  return String(receipt?.transparency?.reasonCode ?? receipt?.transparency?.reason_code ?? '').trim();
}

function receiptOutcomeLabel(receipt) {
  const reasonCode = receiptReasonCode(receipt);
  if (receipt?.finalState === 'completed') return 'Completed';
  if (receipt?.finalState === 'failed' && reasonCode === 'deposit_timeout') return 'Unwound';
  if (receipt?.finalState === 'failed') return 'Failed';
  return 'Unknown';
}

function receiptTone(receipt) {
  if (receipt?.finalState === 'completed') return 'signal';
  if (receipt?.finalState === 'failed') return 'danger';
  return 'neutral';
}

function receiptTypeLabel(receipt) {
  const reasonCode = receiptReasonCode(receipt);
  if (reasonCode) return reasonCode;
  if (receipt?.finalState === 'completed') return 'settlement_completed';
  if (receipt?.finalState === 'failed') return 'settlement_failed';
  return 'settlement_unknown';
}

function receiptOutcomeDetail(receipt) {
  const reasonCode = receiptReasonCode(receipt);
  if (receipt?.finalState === 'completed') return 'All legs settled and released.';
  if (receipt?.finalState === 'failed' && reasonCode === 'deposit_timeout') {
    return 'Counterparty timeout. Deposited assets were refunded.';
  }
  if (receipt?.finalState === 'failed') return 'Cycle failed and settlement was safely unwound.';
  return 'Outcome context unavailable.';
}

function receiptVerificationModel(receipt) {
  const hasKey = Boolean(receipt?.signature?.keyId);
  const hasAlg = Boolean(receipt?.signature?.algorithm);
  const hasSig = Boolean(receipt?.signature?.signature);

  if (hasKey && hasAlg && hasSig) return { label: 'verified', note: 'Signature metadata present.' };
  if (!hasKey && !hasAlg && !hasSig) return { label: 'missing', note: 'Signature metadata missing.' };
  return { label: 'partial', note: 'Signature metadata incomplete.' };
}

function isoMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function receiptRowsFromState(state) {
  const rowsById = new Map();
  const cache = state?.caches?.receipts ?? {};

  for (const [entityKey, entry] of Object.entries(cache)) {
    const receipt = entry?.value ?? null;
    if (!receipt) continue;
    const cycleId = String(receipt?.cycleId ?? entityKey ?? '').trim();
    const receiptId = String(receipt?.id ?? '').trim();
    if (!cycleId && !receiptId) continue;

    const dedupeKey = receiptId || cycleId;
    const normalized = {
      dedupeKey,
      routeReceiptId: cycleId || entityKey,
      cycleId: cycleId || entityKey,
      receiptId: receiptId || cycleId || entityKey,
      receipt,
      updatedAt: Number(entry?.updatedAt ?? 0),
      createdAtMs: isoMs(receipt?.createdAt)
    };

    const existing = rowsById.get(dedupeKey);
    if (!existing || normalized.updatedAt > existing.updatedAt) {
      rowsById.set(dedupeKey, normalized);
    }
  }

  return [...rowsById.values()].sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return String(a.receiptId).localeCompare(String(b.receiptId));
  });
}

function receiptContextFromState(state, routeReceiptId) {
  if (!routeReceiptId) return null;
  const direct = state?.caches?.receipts?.[routeReceiptId]?.value ?? null;
  if (direct) {
    return {
      routeReceiptId,
      cycleId: String(direct?.cycleId ?? routeReceiptId),
      receiptId: String(direct?.id ?? routeReceiptId),
      receipt: direct
    };
  }

  const routeValue = String(routeReceiptId);
  return receiptRowsFromState(state)
    .find(row => row.routeReceiptId === routeValue || row.receiptId === routeValue || row.cycleId === routeValue)
    ?? null;
}

function timelineForCycle(state, cycleId) {
  const direct = state?.caches?.timeline?.[cycleId]?.value ?? null;
  if (direct) return direct;
  const timelineRows = Object.values(state?.caches?.timeline ?? {});
  return timelineRows.find(row => row?.value?.cycleId === cycleId)?.value ?? null;
}

function valueContextForReceipt(state, receipt) {
  const cycleId = String(receipt?.cycleId ?? '').trim();
  if (!cycleId) return { available: false };

  const timeline = timelineForCycle(state, cycleId);
  if (!timeline) return { available: false };

  const viewerActorId = String(state?.session?.actorId ?? '').trim();
  if (!viewerActorId) return { available: false };

  const legs = Array.isArray(timeline?.legs) ? timeline.legs : [];
  const gaveUsd = legs
    .filter(leg => String(leg?.fromActor?.id ?? '') === viewerActorId)
    .flatMap(leg => Array.isArray(leg?.assets) ? leg.assets : [])
    .reduce((sum, asset) => sum + Number(asset?.valueUsd ?? 0), 0);
  const receivedUsd = legs
    .filter(leg => String(leg?.toActor?.id ?? '') === viewerActorId)
    .flatMap(leg => Array.isArray(leg?.assets) ? leg.assets : [])
    .reduce((sum, asset) => sum + Number(asset?.valueUsd ?? 0), 0);
  const feesPaidUsd = (Array.isArray(receipt?.fees) ? receipt.fees : [])
    .filter(fee => String(fee?.actor?.id ?? '') === viewerActorId)
    .reduce((sum, fee) => sum + Number(fee?.feeUsd ?? 0), 0);

  if (!Number.isFinite(gaveUsd) || !Number.isFinite(receivedUsd) || !Number.isFinite(feesPaidUsd)) {
    return { available: false };
  }

  return {
    available: true,
    gaveUsd,
    receivedUsd,
    feesPaidUsd,
    netUsd: receivedUsd - gaveUsd - feesPaidUsd
  };
}

function valueDeltaLabel(context) {
  if (!context?.available) return 'n/a';
  return formatUsd(context.netUsd);
}

function renderTransparencyValue(value) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function renderReceiptsList(state) {
  const rows = receiptRowsFromState(state);
  const clippedRows = clampListForRender(rows);
  if (clippedRows.totalCount === 0) {
    return `
      <section class="screen-block">
        <p class="u-cap">Receipts</p>
        <h2 class="u-display">Verified Records</h2>
        <p class="u-text-base u-ink-2">Completed and unwound cycles appear here with verification metadata.</p>
        ${shellCard(
          'No receipts yet',
          'Complete or unwind a cycle to generate signed receipt records with outcome metadata.',
          '<span class="pill tone-neutral">Status · Type · Verification · Value delta</span>'
        )}
      </section>
    `;
  }

  const completedCount = rows.filter(row => row.receipt?.finalState === 'completed').length;
  const failedCount = rows.filter(row => row.receipt?.finalState === 'failed').length;

  return `
    <section class="screen-block">
      <p class="u-cap">Receipts</p>
      <h2 class="u-display">Verified Records</h2>
      <p class="u-text-base u-ink-2">Status signals and proof metadata stay visible for each completed cycle.</p>
      <p class="u-text-base u-ink-2">Total <span class="u-text-data">${escapeHtml(String(clippedRows.totalCount))}</span> · Completed <span class="u-text-data">${escapeHtml(String(completedCount))}</span> · Failed/Unwound <span class="u-text-data">${escapeHtml(String(failedCount))}</span></p>
      <section class="receipt-list" aria-label="Receipts list">
        ${clippedRows.rows.map(row => {
          const verification = receiptVerificationModel(row.receipt);
          const valueContext = valueContextForReceipt(state, row.receipt);
          return `
            <article class="receipt-card">
              <div class="receipt-card-head">
                <span class="pill tone-${escapeHtml(receiptTone(row.receipt))}">${escapeHtml(receiptOutcomeLabel(row.receipt))}</span>
                <span class="u-text-sm u-ink-3">${escapeHtml(formatIsoShort(row.receipt?.createdAt))}</span>
              </div>
              <h3 class="u-text-md u-weight-600">Cycle <span class="u-text-data">${escapeHtml(row.cycleId)}</span></h3>
              <p class="u-text-sm u-ink-3">Receipt <span class="u-text-data">${escapeHtml(row.receiptId)}</span></p>
              <div class="receipt-meta-grid">
                <div><p class="meta-key u-text-sm">Type</p><p class="meta-val u-text-data">${escapeHtml(receiptTypeLabel(row.receipt))}</p></div>
                <div><p class="meta-key u-text-sm">Verification</p><p class="meta-val u-text-data">${escapeHtml(verification.label)}</p></div>
                <div><p class="meta-key u-text-sm">Value delta</p><p class="meta-val u-text-data">${escapeHtml(valueDeltaLabel(valueContext))}</p></div>
              </div>
              <button
                type="button"
                class="inline-action"
                data-action="receipts.openReceipt"
                data-receipt-id="${escapeHtml(row.routeReceiptId)}"
                data-cycle-id="${escapeHtml(row.cycleId)}"
              >
                Open receipt
              </button>
            </article>
          `;
        }).join('')}
      </section>
      ${clippedRows.truncatedCount > 0
    ? `<p class="u-text-sm u-ink-3">Showing first ${escapeHtml(String(clippedRows.rows.length))} receipts for smooth scrolling. ${escapeHtml(String(clippedRows.truncatedCount))} more available.</p>`
    : ''}
    </section>
  `;
}

function renderReceiptsDetail(state, routeReceiptId) {
  const context = receiptContextFromState(state, routeReceiptId);
  if (!context?.receipt) {
    return `
      <section class="screen-block">
        <p class="u-cap">Receipts</p>
        <h2 class="u-display">Receipt unavailable</h2>
        ${shellCard(
          'Receipt not found',
          `No receipt is currently cached for <span class="u-text-data">${escapeHtml(String(routeReceiptId))}</span>.`,
          '<button type="button" class="inline-action" data-action="receipt.backToList">Back to receipts</button>'
        )}
      </section>
    `;
  }

  const receipt = context.receipt;
  const verification = receiptVerificationModel(receipt);
  const valueContext = valueContextForReceipt(state, receipt);
  const transparencyRows = Object.entries(receipt?.transparency ?? {});
  const liquidityRows = Array.isArray(receipt?.liquidityProviderSummary) ? receipt.liquidityProviderSummary : [];
  const feeRows = Array.isArray(receipt?.fees) ? receipt.fees : [];
  const viewerActorId = String(state?.session?.actorId ?? '').trim();

  return `
    <section class="screen-block">
      <p class="u-cap">Receipts</p>
      <h2 class="u-display">Receipt <span class="u-text-data">${escapeHtml(context.receiptId)}</span></h2>
      <div class="detail-top-actions">
        <button type="button" class="inline-action" data-action="receipt.backToList">Back to receipts</button>
        <span class="pill tone-${escapeHtml(receiptTone(receipt))}">${escapeHtml(receiptOutcomeLabel(receipt))}</span>
      </div>

      <section class="receipt-panel">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Metadata</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(formatIsoShort(receipt.createdAt))}</span>
        </div>
        <div class="meta-grid">
          <div><p class="meta-key u-text-sm">Cycle</p><p class="meta-val u-text-data">${escapeHtml(context.cycleId)}</p></div>
          <div><p class="meta-key u-text-sm">Type</p><p class="meta-val u-text-data">${escapeHtml(receiptTypeLabel(receipt))}</p></div>
          <div><p class="meta-key u-text-sm">Verification</p><p class="meta-val u-text-data">${escapeHtml(verification.label)}</p></div>
          <div><p class="meta-key u-text-sm">Value delta</p><p class="meta-val u-text-data">${escapeHtml(valueDeltaLabel(valueContext))}</p></div>
        </div>
      </section>

      <section class="receipt-panel">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Verification metadata</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(verification.note)}</span>
        </div>
        <div class="meta-grid">
          <div><p class="meta-key u-text-sm">Key id</p><p class="meta-val u-text-data">${escapeHtml(receipt?.signature?.keyId || 'n/a')}</p></div>
          <div><p class="meta-key u-text-sm">Algorithm</p><p class="meta-val u-text-data">${escapeHtml(receipt?.signature?.algorithm || 'n/a')}</p></div>
          <div><p class="meta-key u-text-sm">Signature bytes</p><p class="meta-val u-text-data">${escapeHtml(String(receipt?.signature?.signature?.length ?? 0))}</p></div>
          <div><p class="meta-key u-text-sm">Referenced intents</p><p class="meta-val u-text-data">${escapeHtml(String(receipt?.intentIds?.length ?? 0))}</p></div>
        </div>
      </section>

      <section class="receipt-panel">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Value outcome context</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(receiptOutcomeDetail(receipt))}</span>
        </div>
        ${valueContext.available ? `
          <div class="meta-grid">
            <div><p class="meta-key u-text-sm">You gave</p><p class="meta-val u-text-data">${escapeHtml(formatUsd(valueContext.gaveUsd))}</p></div>
            <div><p class="meta-key u-text-sm">You received</p><p class="meta-val u-text-data">${escapeHtml(formatUsd(valueContext.receivedUsd))}</p></div>
            <div><p class="meta-key u-text-sm">Fees</p><p class="meta-val u-text-data">${escapeHtml(formatUsd(valueContext.feesPaidUsd))}</p></div>
            <div><p class="meta-key u-text-sm">Net delta</p><p class="meta-val u-text-data">${escapeHtml(formatUsd(valueContext.netUsd))}</p></div>
          </div>
        ` : '<p class="u-text-base u-ink-2">Timeline value context is unavailable for this receipt.</p>'}
      </section>

      ${feeRows.length > 0 ? `
        <section class="receipt-panel">
          <div class="proposal-section-head">
            <h3 class="u-text-md u-weight-600">Fees</h3>
            <span class="u-text-sm u-ink-3">${escapeHtml(String(feeRows.length))} entries</span>
          </div>
          <div class="receipt-stack">
            ${feeRows.map(fee => `
              <div class="receipt-row">
                <span class="u-text-sm">${escapeHtml(actorDisplayLabel({
    actorId: fee?.actor?.id,
    viewerActorId,
    includeAtFallback: true
  }))}</span>
                <span class="u-text-data">${escapeHtml(formatUsd(fee?.feeUsd ?? 0))}</span>
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      ${liquidityRows.length > 0 ? `
        <section class="receipt-panel">
          <div class="proposal-section-head">
            <h3 class="u-text-md u-weight-600">Liquidity providers</h3>
            <span class="u-text-sm u-ink-3">${escapeHtml(String(liquidityRows.length))} providers</span>
          </div>
          <div class="receipt-stack">
            ${liquidityRows.map(row => `
              <div class="receipt-row receipt-provider-row">
                <div>
                  <p class="u-text-sm u-weight-600">${escapeHtml(row?.provider?.displayLabel || row?.provider?.providerId || 'provider')}</p>
                  <p class="u-text-sm u-ink-3">${escapeHtml(row?.provider?.providerType || 'n/a')} · ${escapeHtml(String(row?.participantCount ?? 0))} participants</p>
                </div>
                <span class="u-text-sm u-ink-3">${escapeHtml(row?.provider?.active ? 'active' : 'inactive')}</span>
              </div>
            `).join('')}
          </div>
        </section>
      ` : ''}

      <section class="receipt-panel">
        <div class="proposal-section-head">
          <h3 class="u-text-md u-weight-600">Transparency</h3>
          <span class="u-text-sm u-ink-3">${escapeHtml(String(transparencyRows.length))} fields</span>
        </div>
        ${transparencyRows.length === 0
          ? '<p class="u-text-base u-ink-2">No additional transparency metadata reported.</p>'
          : `<div class="receipt-stack">
              ${transparencyRows.map(([key, value]) => `
                <div class="receipt-row">
                  <span class="u-text-sm u-ink-3">${escapeHtml(key)}</span>
                  <span class="u-text-data">${escapeHtml(renderTransparencyValue(value))}</span>
                </div>
              `).join('')}
            </div>`}
      </section>
    </section>
  `;
}

function renderReceipts(state) {
  const receiptId = state?.route?.params?.receiptId ?? null;
  if (receiptId) return renderReceiptsDetail(state, receiptId);
  return renderReceiptsList(state);
}

function renderNotificationPrefsOverlay(state) {
  const prefsState = state?.ui?.notificationPrefs ?? null;
  if (!prefsState?.isOpen) return '';

  const prefs = prefsState.values ?? {};
  const channels = prefs.channels ?? {};
  const quietHours = prefs.quietHours ?? {};

  return `
    <div class="composer-backdrop">
      <button type="button" class="composer-scrim" data-action="notifications.closePrefs" aria-label="Close notification preferences"></button>
      <section class="composer-sheet" role="dialog" aria-modal="true" aria-label="Notification preferences">
        <div class="composer-head">
          <h3 class="u-text-md u-weight-600">Notification preferences</h3>
          <button type="button" class="icon-btn" data-action="notifications.closePrefs" aria-label="Close notification preferences">×</button>
        </div>

        <form data-form="notification-preferences" class="composer-form">
          <div class="field">
            <p class="u-text-sm u-weight-600">Enabled channels</p>
            <div class="choice-row">
              <label class="choice-chip">
                <input type="checkbox" name="channel_proposal" ${channels.proposal ? 'checked' : ''} />
                <span>Proposals</span>
              </label>
              <label class="choice-chip">
                <input type="checkbox" name="channel_active" ${channels.active ? 'checked' : ''} />
                <span>Active swaps</span>
              </label>
              <label class="choice-chip">
                <input type="checkbox" name="channel_receipt" ${channels.receipt ? 'checked' : ''} />
                <span>Receipts</span>
              </label>
            </div>
          </div>

          <div class="field">
            <label class="choice-chip">
              <input type="checkbox" name="quiet_enabled" ${quietHours.enabled ? 'checked' : ''} />
              <span>Enable quiet hours</span>
            </label>
          </div>

          <div class="meta-grid">
            <div class="field">
              <label class="u-text-sm u-weight-600" for="quiet-start-hour">Quiet start hour</label>
              <input
                id="quiet-start-hour"
                class="field-input"
                type="number"
                min="0"
                max="23"
                step="1"
                name="quiet_start_hour"
                value="${escapeHtml(String(quietHours.startHour ?? 22))}"
              />
            </div>
            <div class="field">
              <label class="u-text-sm u-weight-600" for="quiet-end-hour">Quiet end hour</label>
              <input
                id="quiet-end-hour"
                class="field-input"
                type="number"
                min="0"
                max="23"
                step="1"
                name="quiet_end_hour"
                value="${escapeHtml(String(quietHours.endHour ?? 7))}"
              />
            </div>
          </div>

          <div class="field-actions">
            <button type="button" class="btn-inline" data-action="notifications.closePrefs">Cancel</button>
            <button type="submit" class="btn-primary-inline">Save preferences</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

export function renderTabScreen(state) {
  const activeTab = state?.route?.tab ?? 'items';
  let content = '';
  switch (activeTab) {
    case 'intents':
      content = renderIntents(state);
      break;
    case 'inbox':
      content = renderInbox(state);
      break;
    case 'active':
      content = renderActive(state);
      break;
    case 'receipts':
      content = renderReceipts(state);
      break;
    case 'items':
    default:
      content = renderItems(state);
      break;
  }

  return `
    <section
      id="${panelA11yId(activeTab)}"
      role="tabpanel"
      aria-labelledby="${tabA11yId(activeTab)}"
      tabindex="-1"
    >
      ${content}
    </section>
    ${renderNotificationPrefsOverlay(state)}
  `;
}
