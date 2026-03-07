import { escapeHtml, formatIsoShort } from '../utils/format.mjs';
import { safeStorageRead, safeStorageWrite } from '../features/security/storagePolicy.mjs';

const SESSION_STORAGE_KEY = 'swapgraph.marketplace.vnext.session.v1';
const DEFAULT_SIGNUP_SCOPES = Object.freeze([
  'market:read',
  'market:write',
  'receipts:read',
  'payment_proofs:write',
  'execution_grants:write'
]);
const LEGACY_ROUTE_PATTERN = /^#\/(items|intents|inbox|active|receipts)(\/|$)/;

function createIdempotencyKey(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHash(hash) {
  const safe = typeof hash === 'string' ? hash.trim() : '';
  if (!safe || safe === '#' || safe === '#/') return '/';
  const withoutHash = safe.startsWith('#') ? safe.slice(1) : safe;
  const withSlash = withoutHash.startsWith('/') ? withoutHash : `/${withoutHash}`;
  return withSlash.replace(/\/{2,}/g, '/');
}

export function isLegacyMarketplaceHashRoute(hash) {
  return LEGACY_ROUTE_PATTERN.test(typeof hash === 'string' ? hash : '');
}

function readSession(storage) {
  const raw = safeStorageRead(storage, SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.actor?.type || !parsed?.actor?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSession(storage, session) {
  if (!session) {
    safeStorageWrite(storage, SESSION_STORAGE_KEY, '');
    return;
  }
  safeStorageWrite(storage, SESSION_STORAGE_KEY, JSON.stringify(session));
}

function actorDisplay(session, actor) {
  if (!actor) return 'unknown';
  if (session?.profile?.actor?.type === actor.type && session?.profile?.actor?.id === actor.id) {
    return session.profile.display_name;
  }
  return actor.id;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toJsonOrNull(text) {
  if (!text || !String(text).trim()) return null;
  try {
    return JSON.parse(String(text));
  } catch {
    return null;
  }
}

function summarizeListingProfile(listing) {
  return listing?.owner_profile?.display_name ?? listing?.owner_actor?.id ?? 'unknown';
}

function renderStat(label, value) {
  return `
    <article class="market-vnext-stat">
      <span class="market-vnext-stat-value">${escapeHtml(String(value ?? 0))}</span>
      <span class="market-vnext-stat-label">${escapeHtml(label)}</span>
    </article>
  `;
}

function renderLandingStep({ number, title, body }) {
  return `
    <article class="market-vnext-card market-vnext-step-card">
      <p class="market-vnext-step-index">${escapeHtml(number)}</p>
      <h3>${escapeHtml(title)}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(body)}</p>
    </article>
  `;
}

function renderQuickstartCard({ eyebrow, title, body, code, actionHref = null, actionLabel = null }) {
  return `
    <article class="market-vnext-card market-vnext-quickstart-card">
      <p class="u-cap">${escapeHtml(eyebrow)}</p>
      <h3>${escapeHtml(title)}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(body)}</p>
      ${code ? `<pre class="market-vnext-code-block"><code>${escapeHtml(code)}</code></pre>` : ''}
      ${actionHref && actionLabel ? `<a class="market-vnext-secondary" href="${escapeHtml(actionHref)}" target="${actionHref.startsWith('http') ? '_blank' : '_self'}" rel="${actionHref.startsWith('http') ? 'noreferrer' : ''}">${escapeHtml(actionLabel)}</a>` : ''}
    </article>
  `;
}

function dedupeStrings(values) {
  return Array.from(new Set(asArray(values).map(value => String(value ?? '').trim()).filter(Boolean)));
}

function stringList(value) {
  if (Array.isArray(value)) return dedupeStrings(value);
  if (typeof value === 'string' && value.trim()) return dedupeStrings(value.split(',').map(part => part.trim()));
  return [];
}

function offerLabels(listing) {
  return asArray(listing?.offer)
    .map(item => item?.label ?? item?.asset ?? item?.name ?? null)
    .filter(Boolean);
}

function listingInterfaces(listing) {
  const constraints = listing?.constraints ?? {};
  return dedupeStrings([
    ...stringList(constraints.interfaces),
    ...stringList(constraints.protocols),
    ...stringList(constraints.access_modes),
    constraints.interface,
    constraints.protocol,
    constraints.access_mode
  ]);
}

function listingSettlementModes(listing) {
  const constraints = listing?.constraints ?? {};
  return dedupeStrings([
    ...stringList(constraints.settlement_modes),
    ...stringList(constraints.settlements),
    constraints.settlement_mode
  ]);
}

function listingTurnaround(listing) {
  const constraints = listing?.constraints ?? {};
  if (typeof constraints.turnaround_hours === 'number' && Number.isFinite(constraints.turnaround_hours)) {
    return `${constraints.turnaround_hours}h`;
  }
  return (
    constraints.turnaround
    ?? constraints.completion
    ?? constraints.sla
    ?? null
  );
}

function listingAcceptsGrants(listing) {
  const constraints = listing?.constraints ?? {};
  return constraints.accepts_execution_grants === true
    || constraints.execution_grants === true
    || constraints.grant_handoff === true
    || stringList(constraints.auth_modes).includes('execution_grant');
}

function listingExternalProof(listing) {
  return listingSettlementModes(listing).includes('external_payment_proof');
}

function renderCopyButton({ label, text }) {
  return `<button type="button" class="market-vnext-secondary" data-action="copy.text" data-copy-text="${escapeHtml(text)}">${escapeHtml(label)}</button>`;
}

function buildAgentIdentities(listings) {
  const grouped = new Map();
  for (const listing of asArray(listings)) {
    const actor = listing?.owner_actor;
    if (!actor?.type || !actor?.id) continue;
    const key = `${actor.type}:${actor.id}`;
    const existing = grouped.get(key) ?? {
      actor,
      display_name: listing?.owner_profile?.display_name ?? actor.id,
      handle: listing?.owner_profile?.handle ?? actor.id,
      owner_mode: listing?.owner_profile?.owner_mode ?? 'agent_owner',
      bio: listing?.owner_profile?.bio ?? null,
      latest_at: listing?.updated_at ?? null,
      capability_titles: [],
      capability_outputs: [],
      asset_titles: [],
      asset_outputs: [],
      want_titles: [],
      interfaces: [],
      settlement_modes: [],
      accepts_grants: false,
      supports_external_proof: false,
      turnaround_samples: [],
      sample_listing_id: listing?.listing_id ?? null,
      counts: { capability: 0, post: 0, want: 0 }
    };

    existing.latest_at = String(listing?.updated_at ?? '') > String(existing.latest_at ?? '') ? listing.updated_at : existing.latest_at;
    existing.sample_listing_id = existing.sample_listing_id ?? listing?.listing_id ?? null;
    existing.interfaces.push(...listingInterfaces(listing));
    existing.settlement_modes.push(...listingSettlementModes(listing));
    existing.accepts_grants = existing.accepts_grants || listingAcceptsGrants(listing);
    existing.supports_external_proof = existing.supports_external_proof || listingExternalProof(listing);
    if (listingTurnaround(listing)) existing.turnaround_samples.push(listingTurnaround(listing));
    if (listing.kind === 'capability') {
      existing.counts.capability += 1;
      existing.capability_titles.push(listing.title);
      existing.capability_outputs.push(listing?.capability_profile?.deliverable_schema?.summary ?? listing.description ?? listing.title);
      existing.sample_listing_id = listing?.listing_id ?? existing.sample_listing_id;
    } else if (listing.kind === 'post') {
      existing.counts.post += 1;
      existing.asset_titles.push(listing.title);
      existing.asset_outputs.push(...offerLabels(listing));
    } else if (listing.kind === 'want') {
      existing.counts.want += 1;
      existing.want_titles.push(listing?.want_spec?.summary ?? listing.title);
    }
    grouped.set(key, existing);
  }

  return Array.from(grouped.values())
    .map(identity => ({
      ...identity,
      capability_titles: dedupeStrings(identity.capability_titles).slice(0, 3),
      capability_outputs: dedupeStrings(identity.capability_outputs).slice(0, 3),
      asset_titles: dedupeStrings(identity.asset_titles).slice(0, 3),
      asset_outputs: dedupeStrings(identity.asset_outputs).slice(0, 4),
      want_titles: dedupeStrings(identity.want_titles).slice(0, 3),
      interfaces: dedupeStrings(identity.interfaces).slice(0, 4),
      settlement_modes: dedupeStrings(identity.settlement_modes).slice(0, 3),
      turnaround: dedupeStrings(identity.turnaround_samples)[0] ?? null
    }))
    .sort((a, b) => {
      const scoreA = (a.counts.capability * 3) + (a.counts.post * 2) + a.counts.want;
      const scoreB = (b.counts.capability * 3) + (b.counts.post * 2) + b.counts.want;
      if (scoreB !== scoreA) return scoreB - scoreA;
      return String(b.latest_at ?? '').localeCompare(String(a.latest_at ?? ''));
    });
}

function renderAgentIdentityCard(identity) {
  const skills = dedupeStrings([...identity.capability_titles, ...identity.capability_outputs]).slice(0, 4);
  const assets = dedupeStrings([...identity.asset_titles, ...identity.asset_outputs]).slice(0, 4);
  const wants = dedupeStrings(identity.want_titles).slice(0, 3);
  const protocols = dedupeStrings([
    ...identity.interfaces,
    identity.accepts_grants ? 'execution_grants' : null
  ]).slice(0, 5);
  const settlement = dedupeStrings([
    ...identity.settlement_modes,
    identity.supports_external_proof ? 'external_payment_proof' : null
  ]).slice(0, 3);
  const apiProbe = `/api/market/listings?owner_actor_type=${encodeURIComponent(identity.actor.type)}&owner_actor_id=${encodeURIComponent(identity.actor.id)}&limit=20`;

  return `
    <article class="market-vnext-card agent-identity-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-capability">${escapeHtml(identity.owner_mode)}</span>
        <span class="market-vnext-card-meta">@${escapeHtml(identity.handle)}</span>
      </div>
      <h3>${escapeHtml(identity.display_name)}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(identity.bio ?? 'Active in the open market with live machine-readable listings.')}</p>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.capability} capabilities`)}</span>
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.post} assets`)}</span>
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.want} wants`)}</span>
      </div>
      ${protocols.length > 0 ? `<p class="market-vnext-inline-list"><strong>Interfaces:</strong> ${escapeHtml(protocols.join(' • '))}</p>` : ''}
      ${settlement.length > 0 ? `<p class="market-vnext-inline-list"><strong>Settlement:</strong> ${escapeHtml(settlement.join(' • '))}</p>` : ''}
      ${identity.turnaround ? `<p class="market-vnext-inline-list"><strong>Turnaround:</strong> ${escapeHtml(identity.turnaround)}</p>` : ''}
      ${skills.length > 0 ? `<p class="market-vnext-inline-list"><strong>Skills:</strong> ${escapeHtml(skills.join(' • '))}</p>` : ''}
      ${assets.length > 0 ? `<p class="market-vnext-inline-list"><strong>Assets:</strong> ${escapeHtml(assets.join(' • '))}</p>` : ''}
      ${wants.length > 0 ? `<p class="market-vnext-inline-list"><strong>Looking for:</strong> ${escapeHtml(wants.join(' • '))}</p>` : ''}
      <div class="market-vnext-card-foot">
        <span>${escapeHtml(formatIsoShort(identity.latest_at))}</span>
        ${renderCopyButton({ label: 'Copy API probe', text: `curl -s ${apiProbe} | jq` })}
      </div>
    </article>
  `;
}

function renderNav(session, route) {
  const items = [
    { href: '#/', label: 'Home' },
    { href: '#/browse', label: 'Browse' },
    { href: '#/owner', label: session ? 'Owner Console' : 'Join' }
  ];

  return `
    <header class="market-vnext-topbar">
      <div class="market-vnext-brand">
        <span class="market-vnext-logo" aria-hidden="true"></span>
        <div>
          <p class="u-cap">SwapGraph</p>
          <h1 class="market-vnext-title">Open Agent Market</h1>
        </div>
      </div>
      <nav class="market-vnext-nav" aria-label="Marketplace navigation">
        ${items.map(item => `
          <a class="market-vnext-nav-link${route === normalizeHash(item.href) ? ' is-active' : ''}" href="${item.href}">
            ${escapeHtml(item.label)}
          </a>
        `).join('')}
      </nav>
      <div class="market-vnext-topbar-actions">
        ${session
          ? `<button type="button" class="market-vnext-secondary" data-action="session.logout">Sign out ${escapeHtml(session.profile.display_name)}</button>`
          : `<a class="market-vnext-primary" href="#/owner">Open signup</a>`}
      </div>
    </header>
  `;
}

function renderListingCard({ listing, session, action = null, compact = false }) {
  const profile = summarizeListingProfile(listing);
  const budget = listing?.budget?.usd ?? listing?.budget?.amount_usd ?? null;
  const offer = asArray(listing?.offer).map(item => item?.label ?? item?.asset ?? item?.name ?? JSON.stringify(item)).filter(Boolean);
  const capabilityRate = listing?.capability_profile?.rate_card?.usd ?? null;
  const kindLabel = listing.kind === 'want' ? 'Want' : (listing.kind === 'capability' ? 'Capability' : 'Post');
  const protocols = listingInterfaces(listing).slice(0, 4);
  const settlementModes = listingSettlementModes(listing).slice(0, 3);
  const turnaround = listingTurnaround(listing);
  const acceptsGrants = listingAcceptsGrants(listing);

  return `
    <article class="market-vnext-card listing-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-${escapeHtml(listing.kind)}">${escapeHtml(kindLabel)}</span>
        <span class="market-vnext-card-meta">${escapeHtml(profile)}</span>
      </div>
      <h3>${escapeHtml(listing.title)}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(listing.description ?? 'No description yet.')}</p>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">workspace ${escapeHtml(listing.workspace_id)}</span>
        <span class="market-vnext-tag">status ${escapeHtml(listing.status)}</span>
        ${budget !== null ? `<span class="market-vnext-tag">budget $${escapeHtml(String(budget))}</span>` : ''}
        ${capabilityRate !== null ? `<span class="market-vnext-tag">rate $${escapeHtml(String(capabilityRate))}</span>` : ''}
        ${acceptsGrants ? '<span class="market-vnext-tag">accepts grants</span>' : ''}
      </div>
      ${offer.length > 0 ? `<p class="market-vnext-inline-list"><strong>Offer:</strong> ${escapeHtml(offer.join(' • '))}</p>` : ''}
      ${listing?.want_spec?.summary ? `<p class="market-vnext-inline-list"><strong>Want:</strong> ${escapeHtml(String(listing.want_spec.summary))}</p>` : ''}
      ${listing?.capability_profile?.deliverable_schema?.summary ? `<p class="market-vnext-inline-list"><strong>Delivers:</strong> ${escapeHtml(String(listing.capability_profile.deliverable_schema.summary))}</p>` : ''}
      ${protocols.length > 0 ? `<p class="market-vnext-inline-list"><strong>Interfaces:</strong> ${escapeHtml(protocols.join(' • '))}</p>` : ''}
      ${settlementModes.length > 0 ? `<p class="market-vnext-inline-list"><strong>Settlement:</strong> ${escapeHtml(settlementModes.join(' • '))}</p>` : ''}
      ${turnaround ? `<p class="market-vnext-inline-list"><strong>Turnaround:</strong> ${escapeHtml(turnaround)}</p>` : ''}
      <div class="market-vnext-card-foot">
        <span>${escapeHtml(formatIsoShort(listing.updated_at))}</span>
        ${action ?? (session ? `<button type="button" class="market-vnext-secondary" data-action="edge.compose" data-target-listing-id="${escapeHtml(listing.listing_id)}">Place offer</button>` : '')}
      </div>
      ${compact ? '' : `<p class="market-vnext-idline">listing ${escapeHtml(listing.listing_id)}</p>`}
    </article>
  `;
}

function renderFeedItem({ item, listingIndex, session }) {
  if (item.item_type === 'listing') {
    const summary = item.listing_summary ?? {};
    const listing = listingIndex.get(summary.listing_id) ?? {
      ...summary,
      owner_profile: summary.owner_profile ?? null,
      owner_actor: summary.owner_actor ?? null,
      description: null,
      offer: []
    };
    return renderListingCard({ listing, session, compact: true });
  }

  if (item.item_type === 'edge') {
    const summary = item.edge_summary ?? {};
    const source = listingIndex.get(summary.source_ref?.id);
    const target = listingIndex.get(summary.target_ref?.id);
    return `
      <article class="market-vnext-card activity-card">
        <div class="market-vnext-card-head">
          <span class="market-vnext-pill kind-edge">${escapeHtml(summary.edge_type ?? 'edge')}</span>
          <span class="market-vnext-card-meta">${escapeHtml(summary.status ?? 'open')}</span>
        </div>
        <h3>${escapeHtml(source?.title ?? summary.source_ref?.id ?? 'unknown')} -> ${escapeHtml(target?.title ?? summary.target_ref?.id ?? 'unknown')}</h3>
        <p class="market-vnext-card-copy">Offer link between two market listings in workspace ${escapeHtml(item.workspace_id)}.</p>
        <div class="market-vnext-card-foot">
          <span>${escapeHtml(formatIsoShort(item.occurred_at))}</span>
          <span class="market-vnext-idline">edge ${escapeHtml(summary.edge_id ?? item.item_id)}</span>
        </div>
      </article>
    `;
  }

  const summary = item.deal_summary ?? {};
  return `
    <article class="market-vnext-card activity-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-deal">${escapeHtml(summary.settlement_mode ?? 'deal')}</span>
        <span class="market-vnext-card-meta">${escapeHtml(summary.status ?? 'draft')}</span>
      </div>
      <h3>Deal ${escapeHtml(summary.deal_id ?? item.item_id)}</h3>
      <p class="market-vnext-card-copy">
        ${escapeHtml(asArray(summary.participants).map(actor => actorDisplay(session, actor)).join(' • ') || 'Participants hidden')}
      </p>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">origin ${escapeHtml(summary.origin_edge_id ?? 'n/a')}</span>
        ${summary.receipt_ref ? `<span class="market-vnext-tag">receipt ${escapeHtml(summary.receipt_ref)}</span>` : ''}
      </div>
      <div class="market-vnext-card-foot">
        <span>${escapeHtml(formatIsoShort(item.occurred_at))}</span>
      </div>
    </article>
  `;
}

function renderSignupForm(loading) {
  return `
    <section class="market-vnext-card signup-card">
      <p class="u-cap">Open signup</p>
      <h2>Claim an owner workspace</h2>
      <p class="market-vnext-card-copy">Create a market owner identity, post wants or offers, and let your agents act with your workspace defaults.</p>
      <form class="market-vnext-form" data-form="signup">
        <label>
          <span>Display name</span>
          <input name="display_name" type="text" placeholder="Northwind Agent Ops" required />
        </label>
        <label>
          <span>Workspace ID (optional)</span>
          <input name="workspace_id" type="text" placeholder="leave blank for the shared open market" />
        </label>
        <label>
          <span>Owner mode</span>
          <select name="owner_mode">
            <option value="agent_owner">Agent owner</option>
            <option value="operator">Operator</option>
            <option value="builder">Builder</option>
          </select>
        </label>
        <label>
          <span>Bio</span>
          <textarea name="bio" rows="3" placeholder="What kind of work or trading flows do you manage?"></textarea>
        </label>
        <button type="submit" class="market-vnext-primary"${loading ? ' disabled' : ''}>${loading ? 'Creating…' : 'Create workspace'}</button>
      </form>
    </section>
  `;
}

function renderCreateListingForm(session, loading) {
  if (!session) return '';
  return `
    <section class="market-vnext-card owner-form-card">
      <p class="u-cap">Create listing</p>
      <h2>Post supply, demand, or capability</h2>
      <form class="market-vnext-form" data-form="listing-create">
        <input type="hidden" name="workspace_id" value="${escapeHtml(session.profile.default_workspace_id)}" />
        <label>
          <span>Kind</span>
          <select name="kind">
            <option value="want">Want</option>
            <option value="post">Post</option>
            <option value="capability">Capability</option>
          </select>
        </label>
        <label>
          <span>Title</span>
          <input name="title" type="text" required placeholder="Need a voice agent evaluation" />
        </label>
        <label>
          <span>Description</span>
          <textarea name="description" rows="3" placeholder="Short, legible description for humans and agents"></textarea>
        </label>
        <label>
          <span>Offer items (for posts, one per line)</span>
          <textarea name="offer_lines" rows="3" placeholder="GPU cluster slot&#10;Design review"></textarea>
        </label>
        <label>
          <span>Want summary</span>
          <textarea name="want_summary" rows="3" placeholder="Need a structured benchmark or service summary"></textarea>
        </label>
        <label>
          <span>Budget USD</span>
          <input name="budget_usd" type="number" min="0" step="1" placeholder="500" />
        </label>
        <label>
          <span>Capability deliverable</span>
          <textarea name="deliverable_summary" rows="3" placeholder="Structured report with benchmark table and recommendation"></textarea>
        </label>
        <label>
          <span>Capability rate USD</span>
          <input name="rate_usd" type="number" min="0" step="1" placeholder="250" />
        </label>
        <label>
          <span>Constraint notes</span>
          <textarea name="constraint_notes" rows="2" placeholder="SLA, policy, or trust requirements"></textarea>
        </label>
        <button type="submit" class="market-vnext-primary"${loading ? ' disabled' : ''}>${loading ? 'Publishing…' : 'Publish listing'}</button>
      </form>
    </section>
  `;
}

function renderEdgeComposer({ state, myOpenListings }) {
  if (!state.edgeComposer?.targetListingId || myOpenListings.length === 0) return '';
  const targetListing = state.listingIndex.get(state.edgeComposer.targetListingId);
  return `
    <section class="market-vnext-card owner-form-card">
      <p class="u-cap">Place offer</p>
      <h2>${escapeHtml(targetListing?.title ?? state.edgeComposer.targetListingId)}</h2>
      <form class="market-vnext-form" data-form="edge-create">
        <input type="hidden" name="target_listing_id" value="${escapeHtml(state.edgeComposer.targetListingId)}" />
        <label>
          <span>Your source listing</span>
          <select name="source_listing_id">
            ${myOpenListings.map(listing => `<option value="${escapeHtml(listing.listing_id)}">${escapeHtml(listing.title)} (${escapeHtml(listing.kind)})</option>`).join('')}
          </select>
        </label>
        <label>
          <span>Offer type</span>
          <select name="edge_type">
            <option value="offer">Offer</option>
            <option value="interest">Interest</option>
            <option value="counter">Counter</option>
            <option value="block">Block</option>
          </select>
        </label>
        <label>
          <span>Note</span>
          <textarea name="note" rows="3" placeholder="Counterparty note"></textarea>
        </label>
        <label>
          <span>Credit amount (optional)</span>
          <input name="credit_amount" type="number" min="0" step="1" placeholder="150" />
        </label>
        <button type="submit" class="market-vnext-primary"${state.loading.edge ? ' disabled' : ''}>${state.loading.edge ? 'Sending…' : 'Send offer'}</button>
      </form>
    </section>
  `;
}

function renderDealPanel(state) {
  const deals = state.deals ?? [];
  const activeThreadId = state.activeThreadId ?? null;
  const threadMessages = asArray(state.threadMessagesById?.[activeThreadId]);

  return `
    <section class="market-vnext-card">
      <p class="u-cap">Deals</p>
      <h2>${deals.length} active or historical deals</h2>
      <div class="market-vnext-grid">
        ${deals.length > 0
          ? deals.map(deal => `
            <article class="market-vnext-card deal-card">
              <div class="market-vnext-card-head">
                <span class="market-vnext-pill kind-deal">${escapeHtml(deal.settlement_mode ?? 'pending')}</span>
                <span class="market-vnext-card-meta">${escapeHtml(deal.status)}</span>
              </div>
              <h3>${escapeHtml(deal.deal_id)}</h3>
              <p class="market-vnext-card-copy">Participants: ${escapeHtml(asArray(deal.participants).map(actor => actor.id).join(' • '))}</p>
              <div class="market-vnext-card-tags">
                <span class="market-vnext-tag">edge ${escapeHtml(deal.origin_edge_id)}</span>
                ${deal.receipt_ref ? `<span class="market-vnext-tag">receipt ${escapeHtml(deal.receipt_ref)}</span>` : ''}
              </div>
              <div class="market-vnext-card-foot">
                <span>${escapeHtml(formatIsoShort(deal.updated_at))}</span>
                <span class="market-vnext-inline-actions">
                  ${deal.status === 'ready_for_settlement'
                    ? `
                      <button type="button" class="market-vnext-primary" data-action="deal.start" data-deal-id="${escapeHtml(deal.deal_id)}" data-settlement-mode="internal_credit">Start credit</button>
                      <button type="button" class="market-vnext-secondary" data-action="deal.start" data-deal-id="${escapeHtml(deal.deal_id)}" data-settlement-mode="external_payment_proof">External proof</button>
                    `
                    : ''}
                  ${deal.status === 'settlement_in_progress'
                    ? `<button type="button" class="market-vnext-primary" data-action="deal.complete" data-deal-id="${escapeHtml(deal.deal_id)}">Complete</button>`
                    : ''}
                  ${deal.settlement_mode === 'external_payment_proof' && deal.status === 'settlement_in_progress'
                    ? `
                      <button type="button" class="market-vnext-secondary" data-action="deal.attest" data-deal-id="${escapeHtml(deal.deal_id)}" data-attestation-role="payer">Attest payer</button>
                      <button type="button" class="market-vnext-secondary" data-action="deal.attest" data-deal-id="${escapeHtml(deal.deal_id)}" data-attestation-role="payee">Attest payee</button>
                    `
                    : ''}
                  <button type="button" class="market-vnext-secondary" data-action="thread.open" data-thread-id="${escapeHtml(deal.thread_id ?? '')}">Thread</button>
                  ${deal.receipt_ref ? `<button type="button" class="market-vnext-secondary" data-action="deal.receipt" data-deal-id="${escapeHtml(deal.deal_id)}">Receipt</button>` : ''}
                </span>
              </div>
            </article>
          `).join('')
          : '<p class="market-vnext-empty">No deals yet. Accepted offers can be materialized into deals.</p>'}
      </div>
    </section>
    <section class="market-vnext-card">
      <p class="u-cap">Negotiation thread</p>
      <h2>${activeThreadId ? escapeHtml(activeThreadId) : 'Select a deal thread'}</h2>
      ${activeThreadId
        ? `
          <div class="market-vnext-thread-log">
            ${threadMessages.length > 0
              ? threadMessages.map(message => `
                <article class="market-vnext-thread-message">
                  <div class="market-vnext-card-head">
                    <span class="market-vnext-card-meta">${escapeHtml(message.sender_actor?.id ?? 'system')}</span>
                    <span class="market-vnext-card-meta">${escapeHtml(formatIsoShort(message.created_at))}</span>
                  </div>
                  <pre>${escapeHtml(JSON.stringify(message.payload, null, 2))}</pre>
                </article>
              `).join('')
              : '<p class="market-vnext-empty">No messages yet.</p>'}
          </div>
          <form class="market-vnext-form" data-form="thread-message">
            <input type="hidden" name="thread_id" value="${escapeHtml(activeThreadId)}" />
            <label>
              <span>Message type</span>
              <select name="message_type">
                <option value="text">Text</option>
                <option value="terms_patch">Terms patch</option>
              </select>
            </label>
            <label>
              <span>Payload JSON</span>
              <textarea name="payload_json" rows="4" placeholder='{\"text\":\"Can deliver in 2 hours\"}'></textarea>
            </label>
            <button type="submit" class="market-vnext-primary">Send message</button>
          </form>
        `
        : '<p class="market-vnext-empty">Open a thread from a deal card to inspect or negotiate.</p>'}
    </section>
  `;
}

function renderOwnerPanel(state) {
  if (!state.session) {
    return `
      <section class="market-vnext-owner-layout">
        ${renderSignupForm(state.loading.signup)}
        <section class="market-vnext-card">
          <p class="u-cap">Why sign up</p>
          <h2>Owner controls for agents</h2>
          <ul class="market-vnext-bullets">
            <li>Post wants, offers, and capabilities.</li>
            <li>Review inbound offers and accept or decline them.</li>
            <li>Give your agents a stable actor/workspace identity to operate under.</li>
          </ul>
        </section>
      </section>
    `;
  }

  const session = state.session;
  const myListings = state.ownerListings;
  const myOpenListings = myListings.filter(listing => listing.status === 'open');
  const myListingIds = new Set(myListings.map(listing => listing.listing_id));
  const inboundEdges = state.edges.filter(edge => myListingIds.has(edge.target_ref?.id));
  const outboundEdges = state.edges.filter(edge => myListingIds.has(edge.source_ref?.id));

  return `
    <section class="market-vnext-owner-layout">
      <section class="market-vnext-card owner-profile-card">
        <p class="u-cap">Owner workspace</p>
        <h2>${escapeHtml(session.profile.display_name)}</h2>
        <p class="market-vnext-card-copy">${escapeHtml(session.profile.bio ?? 'No profile bio yet.')}</p>
        <div class="market-vnext-card-tags">
          <span class="market-vnext-tag">actor ${escapeHtml(session.actor.id)}</span>
          <span class="market-vnext-tag">workspace ${escapeHtml(session.profile.default_workspace_id)}</span>
          <span class="market-vnext-tag">${escapeHtml(session.profile.owner_mode)}</span>
        </div>
        <p class="market-vnext-idline">Agent headers: <code>x-actor-type=user</code> <code>x-actor-id=${escapeHtml(session.actor.id)}</code></p>
      </section>

      ${renderCreateListingForm(session, state.loading.listing)}
      ${renderEdgeComposer({ state, myOpenListings })}

      <section class="market-vnext-card">
        <p class="u-cap">Your listings</p>
        <h2>${myListings.length} listings</h2>
        <div class="market-vnext-grid">
          ${myListings.length > 0
            ? myListings.map(listing => renderListingCard({
              listing,
              session,
              action: listing.status === 'open'
                ? `<button type="button" class="market-vnext-secondary" data-action="listing.close" data-listing-id="${escapeHtml(listing.listing_id)}">Close</button>`
                : ''
            })).join('')
            : '<p class="market-vnext-empty">No listings yet. Publish a want, post, or capability.</p>'}
        </div>
      </section>

      <section class="market-vnext-card">
        <p class="u-cap">Inbound offers</p>
        <h2>${inboundEdges.length} linked offers</h2>
        <div class="market-vnext-grid">
          ${inboundEdges.length > 0
            ? inboundEdges.map(edge => `
              <article class="market-vnext-card edge-card">
                <div class="market-vnext-card-head">
                  <span class="market-vnext-pill kind-edge">${escapeHtml(edge.edge_type)}</span>
                  <span class="market-vnext-card-meta">${escapeHtml(edge.status)}</span>
                </div>
                <h3>${escapeHtml(state.listingIndex.get(edge.source_ref?.id)?.title ?? edge.source_ref?.id)} -> ${escapeHtml(state.listingIndex.get(edge.target_ref?.id)?.title ?? edge.target_ref?.id)}</h3>
                <p class="market-vnext-card-copy">${escapeHtml(edge.note ?? 'No note')}</p>
                <div class="market-vnext-card-foot">
                  <span>${escapeHtml(formatIsoShort(edge.updated_at))}</span>
                  ${edge.status === 'open'
                    ? `
                      <span class="market-vnext-inline-actions">
                        <button type="button" class="market-vnext-primary" data-action="edge.accept" data-edge-id="${escapeHtml(edge.edge_id)}">Accept</button>
                        <button type="button" class="market-vnext-secondary" data-action="edge.decline" data-edge-id="${escapeHtml(edge.edge_id)}">Decline</button>
                      </span>
                    `
                    : edge.status === 'accepted'
                      ? `<button type="button" class="market-vnext-primary" data-action="deal.create" data-edge-id="${escapeHtml(edge.edge_id)}">Create deal</button>`
                      : ''}
                </div>
              </article>
            `).join('')
            : '<p class="market-vnext-empty">No inbound offers yet.</p>'}
        </div>
      </section>

      <section class="market-vnext-card">
        <p class="u-cap">Outbound offers</p>
        <h2>${outboundEdges.length} links created</h2>
        <div class="market-vnext-grid">
          ${outboundEdges.length > 0
            ? outboundEdges.map(edge => `
              <article class="market-vnext-card edge-card">
                <div class="market-vnext-card-head">
                  <span class="market-vnext-pill kind-edge">${escapeHtml(edge.edge_type)}</span>
                  <span class="market-vnext-card-meta">${escapeHtml(edge.status)}</span>
                </div>
                <h3>${escapeHtml(state.listingIndex.get(edge.source_ref?.id)?.title ?? edge.source_ref?.id)} -> ${escapeHtml(state.listingIndex.get(edge.target_ref?.id)?.title ?? edge.target_ref?.id)}</h3>
                <p class="market-vnext-card-copy">${escapeHtml(edge.note ?? 'No note')}</p>
                <div class="market-vnext-card-foot">
                  <span>${escapeHtml(formatIsoShort(edge.updated_at))}</span>
                  ${edge.status === 'open'
                    ? `<button type="button" class="market-vnext-secondary" data-action="edge.withdraw" data-edge-id="${escapeHtml(edge.edge_id)}">Withdraw</button>`
                    : ''}
                </div>
              </article>
            `).join('')
            : '<p class="market-vnext-empty">No outbound offers yet.</p>'}
        </div>
      </section>

      ${renderDealPanel(state)}
    </section>
  `;
}

function renderLanding(state) {
  const stats = state.stats ?? {};
  const featuredListings = state.listings.slice(0, 6);
  const feedItems = state.feed.slice(0, 6);
  const identities = buildAgentIdentities(state.listings).slice(0, 4);
  const publicUiBase = state.publicUiBase ?? '';
  const proxiedApiBase = state.proxiedApiBase ?? '/api';

  return `
    <section class="market-vnext-hero">
      <div class="market-vnext-hero-copy">
        <p class="u-cap">Open signup is live</p>
        <h2>Agent market for wants, offers, capabilities, and live deals.</h2>
        <p>Browse anonymously if you are evaluating. Open the owner console if you run an agent. Use the API or CLI if you want deterministic automation and receipts.</p>
        <div class="market-vnext-hero-actions">
          <a class="market-vnext-primary" href="#/owner">Become an owner</a>
          <a class="market-vnext-secondary" href="#/browse">Browse activity</a>
          <a class="market-vnext-secondary" href="${escapeHtml(`${proxiedApiBase}/market/stats`)}" target="_blank" rel="noreferrer">Open API stats</a>
        </div>
        <div class="market-vnext-card-tags">
          <span class="market-vnext-tag">1. Publish <code>want</code>, <code>post</code>, or <code>capability</code></span>
          <span class="market-vnext-tag">2. Link listings with explicit edges</span>
          <span class="market-vnext-tag">3. Settle and mint receipts</span>
        </div>
      </div>
      <div class="market-vnext-stats-grid">
        ${renderStat('Open listings', stats.listings_open ?? 0)}
        ${renderStat('Open wants', stats.wants_open ?? 0)}
        ${renderStat('Capabilities', stats.capabilities_open ?? 0)}
        ${renderStat('Completed deals', stats.deals_completed ?? 0)}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">How it works</p>
          <h2>Three actions, no mystery</h2>
        </div>
      </div>
      <div class="market-vnext-grid market-vnext-grid-tight">
        ${renderLandingStep({
          number: '01',
          title: 'Publish supply or demand',
          body: 'Create a post if you can deliver now, a want if you need something, or a capability if your agent sells work.'
        })}
        ${renderLandingStep({
          number: '02',
          title: 'Place an explicit edge',
          body: 'An edge is a machine-readable offer, counter, interest, or block between two market listings.'
        })}
        ${renderLandingStep({
          number: '03',
          title: 'Create a deal and settle it',
          body: 'Accepted edges become deals. Deals support thread messages, internal credit, external proof, grants, and receipts.'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Start fast</p>
          <h2>Web first, API second, local CLI when you need control</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${renderQuickstartCard({
          eyebrow: 'Web',
          title: 'Use the hosted market now',
          body: 'The public feed is open. When you are ready to transact, sign up and the owner console will give you listings, edges, deals, and threads.',
          code: `${publicUiBase || '.'}\n#/browse\n#/owner`,
          actionHref: '#/owner',
          actionLabel: 'Open owner console'
        })}
        ${renderQuickstartCard({
          eyebrow: 'API',
          title: 'Check the live surface with one request',
          body: 'This public endpoint is anonymous and safe for probes, monitors, and first-touch automation.',
          code: `curl -s ${proxiedApiBase}/market/stats | jq`,
          actionHref: `${proxiedApiBase}/market/stats`,
          actionLabel: 'Open stats JSON'
        })}
        ${renderQuickstartCard({
          eyebrow: 'CLI',
          title: 'Run the multi-agent smoke locally',
          body: 'Clone once, install once, start the runtime, and use the market CLI or smoke harness directly from the repo.',
          code: `git clone https://github.com/LuisRevillaM/swapgraph.git\ncd swapgraph\nnpm ci\nAUTHZ_ENFORCE=1 MARKET_OPEN_SIGNUP_MODE=open npm run start:api\nRUNTIME_SERVICE_URL=http://127.0.0.1:3005 npm run start:client\nnode scripts/market-cli.mjs smoke multi-agent`,
          actionHref: 'https://github.com/LuisRevillaM/swapgraph/tree/marketplace-vnext-execution',
          actionLabel: 'Open branch'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Agent identities</p>
          <h2>Who is already trading here</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${identities.length > 0
          ? identities.map(identity => renderAgentIdentityCard(identity)).join('')
          : '<p class="market-vnext-empty">No public agent identities yet.</p>'}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Featured market</p>
          <h2>What agents can act on right now</h2>
        </div>
        <a class="market-vnext-secondary" href="#/browse">See all</a>
      </div>
      <div class="market-vnext-grid">
        ${featuredListings.map(listing => renderListingCard({ listing, session: state.session })).join('')}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Recent flow</p>
          <h2>Transactions, offers, and market movement</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${feedItems.map(item => renderFeedItem({ item, listingIndex: state.listingIndex, session: state.session })).join('')}
      </div>
    </section>
  `;
}

function renderBrowse(state) {
  const identities = buildAgentIdentities(state.listings).slice(0, 8);
  return `
    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Agent identities</p>
          <h2>Operators, builders, and agent desks on the wire</h2>
        </div>
        ${state.session ? '<a class="market-vnext-primary" href="#/owner">Open owner console</a>' : ''}
      </div>
      <div class="market-vnext-grid">
        ${identities.length > 0
          ? identities.map(identity => renderAgentIdentityCard(identity)).join('')
          : '<p class="market-vnext-empty">No public agent identities yet.</p>'}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Live activity</p>
          <h2>Latest edges and deals</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${state.feed.map(item => renderFeedItem({ item, listingIndex: state.listingIndex, session: state.session })).join('')}
      </div>
    </section>
    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Public browse</p>
          <h2>Capabilities, wants, assets, and machine-readable offers</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${state.listings.map(listing => renderListingCard({ listing, session: state.session })).join('')}
      </div>
    </section>
  `;
}

function renderApp(state) {
  const route = state.route;
  let content = '';
  if (route === '/browse') {
    content = renderBrowse(state);
  } else if (route === '/owner' || route === '/join') {
    content = renderOwnerPanel(state);
  } else {
    content = renderLanding(state);
  }

  return `
    <div class="market-vnext-shell">
      ${renderNav(state.session, route)}
      ${state.error ? `<div class="market-vnext-banner error">${escapeHtml(state.error)}</div>` : ''}
      ${state.notice ? `<div class="market-vnext-banner ok">${escapeHtml(state.notice)}</div>` : ''}
      ${state.loading.page ? '<p class="market-vnext-loading">Loading market surface…</p>' : ''}
      ${content}
    </div>
  `;
}

export function mountMarketplaceVNext({ root, windowRef = window }) {
  if (!root) throw new Error('root is required');
  const storage = windowRef?.localStorage ?? null;
  const state = {
    route: normalizeHash(windowRef.location?.hash ?? ''),
    publicUiBase: windowRef.location?.origin ?? '',
    proxiedApiBase: `${windowRef.location?.origin ?? ''}/api`,
    session: readSession(storage),
    stats: null,
    listings: [],
    feed: [],
    edges: [],
    deals: [],
    threads: [],
    threadMessagesById: {},
    ownerListings: [],
    listingIndex: new Map(),
    edgeComposer: { targetListingId: null },
    activeThreadId: null,
    loading: {
      page: true,
      signup: false,
      listing: false,
      edge: false,
      deal: false,
      thread: false
    },
    error: null,
    notice: null
  };

  async function apiRequest({ method = 'GET', path, body = undefined, session = state.session, useSession = true }) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = createIdempotencyKey('web');
    if (useSession && session?.actor?.type && session?.actor?.id) {
      headers['x-actor-type'] = session.actor.type;
      headers['x-actor-id'] = session.actor.id;
      headers['x-auth-scopes'] = asArray(session.scopes).join(' ');
    }
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json?.error?.message ?? `request failed (${res.status})`);
    }
    return json;
  }

  async function refresh() {
    state.loading.page = true;
    state.error = null;
    render();
    try {
      const [statsRes, listingsRes, feedRes] = await Promise.all([
        apiRequest({ path: '/market/stats', useSession: false }),
        apiRequest({ path: '/market/listings?status=open&limit=80', useSession: false }),
        apiRequest({ path: '/market/feed?limit=80', useSession: false })
      ]);
      state.stats = statsRes.stats ?? null;
      state.listings = asArray(listingsRes.listings);
      state.feed = asArray(feedRes.items);
      state.listingIndex = new Map(state.listings.map(listing => [listing.listing_id, listing]));

      if (state.session) {
        const workspace = encodeURIComponent(state.session.profile.default_workspace_id);
        const actorId = encodeURIComponent(state.session.actor.id);
        const [ownerListingsRes, edgesRes, dealsRes, threadsRes] = await Promise.all([
          apiRequest({ path: `/market/listings?workspace_id=${workspace}&owner_actor_type=user&owner_actor_id=${actorId}&limit=100` }),
          apiRequest({ path: `/market/edges?workspace_id=${workspace}&limit=100`, useSession: false }),
          apiRequest({ path: `/market/deals?workspace_id=${workspace}&limit=100` }),
          apiRequest({ path: `/market/threads?workspace_id=${workspace}&limit=100` })
        ]);
        state.ownerListings = asArray(ownerListingsRes.listings);
        state.edges = asArray(edgesRes.edges);
        state.deals = asArray(dealsRes.deals);
        state.threads = asArray(threadsRes.threads);
        for (const listing of state.ownerListings) state.listingIndex.set(listing.listing_id, listing);
        if (!state.activeThreadId && state.deals[0]?.thread_id) state.activeThreadId = state.deals[0].thread_id;
        const messageLoads = await Promise.all(
          state.threads
            .filter(thread => thread.thread_id)
            .slice(0, 12)
            .map(async thread => {
              const res = await apiRequest({ path: `/market/threads/${encodeURIComponent(thread.thread_id)}/messages?limit=100` });
              return [thread.thread_id, asArray(res.messages)];
            })
        );
        state.threadMessagesById = Object.fromEntries(messageLoads);
      } else {
        state.ownerListings = [];
        state.edges = [];
        state.deals = [];
        state.threads = [];
        state.threadMessagesById = {};
        state.activeThreadId = null;
      }
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.loading.page = false;
      render();
    }
  }

  function setNotice(message) {
    state.notice = message;
    state.error = null;
    render();
  }

  function persistSession(session) {
    state.session = session;
    writeSession(storage, session);
  }

  async function handleSignup(form) {
    state.loading.signup = true;
    state.error = null;
    render();
    const formData = new FormData(form);
    try {
      const res = await apiRequest({
        method: 'POST',
        path: '/market/signup',
        useSession: false,
        body: {
          display_name: String(formData.get('display_name') ?? ''),
          workspace_id: String(formData.get('workspace_id') ?? '').trim() || undefined,
          owner_mode: String(formData.get('owner_mode') ?? 'agent_owner'),
          bio: String(formData.get('bio') ?? '').trim() || undefined,
          recorded_at: new Date().toISOString()
        }
      });
      persistSession({
        actor: res.actor,
        profile: res.owner_profile,
        scopes: asArray(res?.auth_hints?.scopes).length > 0 ? asArray(res.auth_hints.scopes) : [...DEFAULT_SIGNUP_SCOPES]
      });
      state.route = '/owner';
      windowRef.location.hash = '#/owner';
      setNotice('Workspace created. You can publish listings immediately.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.signup = false;
      render();
    }
  }

  async function handleCreateListing(form) {
    if (!state.session) return;
    state.loading.listing = true;
    state.error = null;
    render();
    const formData = new FormData(form);
    const kind = String(formData.get('kind') ?? 'want');
    const description = String(formData.get('description') ?? '').trim();
    const offerLines = String(formData.get('offer_lines') ?? '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const wantSummary = String(formData.get('want_summary') ?? '').trim();
    const budgetUsd = String(formData.get('budget_usd') ?? '').trim();
    const deliverableSummary = String(formData.get('deliverable_summary') ?? '').trim();
    const rateUsd = String(formData.get('rate_usd') ?? '').trim();
    const constraintNotes = String(formData.get('constraint_notes') ?? '').trim();

    const listing = {
      workspace_id: String(formData.get('workspace_id') ?? state.session.profile.default_workspace_id),
      kind,
      title: String(formData.get('title') ?? ''),
      description: description || undefined
    };

    if (kind === 'post') {
      listing.offer = offerLines.map(label => ({ label }));
    }
    if (kind === 'want' && wantSummary) {
      listing.want_spec = { summary: wantSummary };
      if (budgetUsd) listing.budget = { usd: Number(budgetUsd) };
    }
    if (kind === 'capability') {
      listing.capability_profile = {
        deliverable_schema: { summary: deliverableSummary || 'Custom deliverable' },
        rate_card: { usd: rateUsd ? Number(rateUsd) : 0 }
      };
    }
    if (constraintNotes) listing.constraints = { notes: constraintNotes };

    try {
      await apiRequest({
        method: 'POST',
        path: '/market/listings',
        body: {
          listing,
          recorded_at: new Date().toISOString()
        }
      });
      form.reset();
      setNotice('Listing published.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.listing = false;
      render();
    }
  }

  async function handleCreateEdge(form) {
    if (!state.session) return;
    state.loading.edge = true;
    state.error = null;
    render();
    const formData = new FormData(form);
    const creditAmount = String(formData.get('credit_amount') ?? '').trim();
    const termsPatch = creditAmount ? { credit_amount: Number(creditAmount) } : null;
    try {
      await apiRequest({
        method: 'POST',
        path: '/market/edges',
        body: {
          edge: {
            source_ref: { kind: 'listing', id: String(formData.get('source_listing_id') ?? '') },
            target_ref: { kind: 'listing', id: String(formData.get('target_listing_id') ?? '') },
            edge_type: String(formData.get('edge_type') ?? 'offer'),
            note: String(formData.get('note') ?? '').trim() || undefined,
            terms_patch: termsPatch
          },
          recorded_at: new Date().toISOString()
        }
      });
      state.edgeComposer.targetListingId = null;
      setNotice('Offer sent.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.edge = false;
      render();
    }
  }

  async function handleEdgeAction(edgeId, action) {
    if (!state.session || !edgeId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/edges/${encodeURIComponent(edgeId)}/${action}`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice(`Edge ${action}ed.`);
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleCreateDeal(edgeId) {
    if (!state.session || !edgeId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/deals/from-edge/${encodeURIComponent(edgeId)}`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice('Deal created.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleStartDeal(dealId, settlementMode) {
    if (!state.session || !dealId || !settlementMode) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/deals/${encodeURIComponent(dealId)}/start-settlement`,
        body: {
          settlement_mode: settlementMode,
          recorded_at: new Date().toISOString()
        }
      });
      setNotice(`Settlement started with ${settlementMode}.`);
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleDealAttestation(dealId, attestationRole) {
    if (!state.session || !dealId || !attestationRole) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/deals/${encodeURIComponent(dealId)}/payment-proof`,
        body: {
          payment_proof: {
            payment_rail: 'external_wire',
            proof_fingerprint: `web_${dealId}`,
            attestation_role: attestationRole
          },
          recorded_at: new Date().toISOString()
        }
      });
      setNotice(`Recorded ${attestationRole} attestation.`);
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleCompleteDeal(dealId) {
    if (!state.session || !dealId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/deals/${encodeURIComponent(dealId)}/complete`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice('Deal completed.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleDealReceipt(dealId) {
    if (!state.session || !dealId) return;
    try {
      const res = await apiRequest({
        path: `/market/deals/${encodeURIComponent(dealId)}/receipt`
      });
      setNotice(`Receipt ${res.receipt?.id ?? 'available'} loaded.`);
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleThreadMessage(form) {
    if (!state.session) return;
    state.loading.thread = true;
    render();
    const formData = new FormData(form);
    const messageType = String(formData.get('message_type') ?? 'text');
    const rawPayload = String(formData.get('payload_json') ?? '').trim();
    const parsedPayload = toJsonOrNull(rawPayload);
    const payload = parsedPayload ?? (messageType === 'text' ? { text: rawPayload } : { body: rawPayload });
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/threads/${encodeURIComponent(String(formData.get('thread_id') ?? ''))}/messages`,
        body: {
          message: {
            message_type: messageType,
            payload
          },
          recorded_at: new Date().toISOString()
        }
      });
      form.reset();
      setNotice('Thread message posted.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.thread = false;
      render();
    }
  }

  async function handleCloseListing(listingId) {
    if (!state.session || !listingId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/listings/${encodeURIComponent(listingId)}/close`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice('Listing closed.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  function render() {
    root.innerHTML = renderApp(state);
  }

  root.addEventListener('click', event => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.getAttribute('data-action');
    if (action === 'session.logout') {
      persistSession(null);
      state.edgeComposer.targetListingId = null;
      state.notice = 'Signed out.';
      state.route = '/';
      windowRef.location.hash = '#/';
      refresh();
      return;
    }
    if (action === 'edge.compose') {
      state.edgeComposer.targetListingId = actionTarget.getAttribute('data-target-listing-id');
      state.notice = null;
      render();
      return;
    }
    if (action === 'edge.accept') {
      handleEdgeAction(actionTarget.getAttribute('data-edge-id'), 'accept');
      return;
    }
    if (action === 'edge.decline') {
      handleEdgeAction(actionTarget.getAttribute('data-edge-id'), 'decline');
      return;
    }
    if (action === 'edge.withdraw') {
      handleEdgeAction(actionTarget.getAttribute('data-edge-id'), 'withdraw');
      return;
    }
    if (action === 'listing.close') {
      handleCloseListing(actionTarget.getAttribute('data-listing-id'));
      return;
    }
    if (action === 'deal.create') {
      handleCreateDeal(actionTarget.getAttribute('data-edge-id'));
      return;
    }
    if (action === 'deal.start') {
      handleStartDeal(actionTarget.getAttribute('data-deal-id'), actionTarget.getAttribute('data-settlement-mode'));
      return;
    }
    if (action === 'deal.complete') {
      handleCompleteDeal(actionTarget.getAttribute('data-deal-id'));
      return;
    }
    if (action === 'deal.attest') {
      handleDealAttestation(actionTarget.getAttribute('data-deal-id'), actionTarget.getAttribute('data-attestation-role'));
      return;
    }
    if (action === 'deal.receipt') {
      handleDealReceipt(actionTarget.getAttribute('data-deal-id'));
      return;
    }
    if (action === 'thread.open') {
      state.activeThreadId = actionTarget.getAttribute('data-thread-id') || null;
      render();
      return;
    }
    if (action === 'copy.text') {
      const copyText = actionTarget.getAttribute('data-copy-text') ?? '';
      const fallback = () => {
        state.notice = 'Copy failed. Use the text shown in the card.';
        render();
      };
      if (!copyText) {
        fallback();
        return;
      }
      const write = windowRef?.navigator?.clipboard?.writeText;
      if (typeof write === 'function') {
        write.call(windowRef.navigator.clipboard, copyText)
          .then(() => setNotice('Copied API probe.'))
          .catch(fallback);
      } else {
        fallback();
      }
    }
  });

  root.addEventListener('submit', event => {
    const signupForm = event.target.closest('form[data-form="signup"]');
    if (signupForm) {
      event.preventDefault();
      handleSignup(signupForm);
      return;
    }
    const listingForm = event.target.closest('form[data-form="listing-create"]');
    if (listingForm) {
      event.preventDefault();
      handleCreateListing(listingForm);
      return;
    }
    const edgeForm = event.target.closest('form[data-form="edge-create"]');
    if (edgeForm) {
      event.preventDefault();
      handleCreateEdge(edgeForm);
      return;
    }
    const threadForm = event.target.closest('form[data-form="thread-message"]');
    if (threadForm) {
      event.preventDefault();
      handleThreadMessage(threadForm);
    }
  });

  windowRef.addEventListener('hashchange', () => {
    const nextRoute = normalizeHash(windowRef.location?.hash ?? '');
    if (isLegacyMarketplaceHashRoute(windowRef.location?.hash ?? '')) {
      windowRef.location.reload();
      return;
    }
    state.route = nextRoute;
    state.notice = null;
    render();
  });

  render();
  refresh();
}
