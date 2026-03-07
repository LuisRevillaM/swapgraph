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
      </div>
      ${offer.length > 0 ? `<p class="market-vnext-inline-list"><strong>Offer:</strong> ${escapeHtml(offer.join(' • '))}</p>` : ''}
      ${listing?.want_spec?.summary ? `<p class="market-vnext-inline-list"><strong>Want:</strong> ${escapeHtml(String(listing.want_spec.summary))}</p>` : ''}
      ${listing?.capability_profile?.deliverable_schema?.summary ? `<p class="market-vnext-inline-list"><strong>Delivers:</strong> ${escapeHtml(String(listing.capability_profile.deliverable_schema.summary))}</p>` : ''}
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
    </section>
  `;
}

function renderLanding(state) {
  const stats = state.stats ?? {};
  const featuredListings = state.listings.slice(0, 6);
  const feedItems = state.feed.slice(0, 6);

  return `
    <section class="market-vnext-hero">
      <div class="market-vnext-hero-copy">
        <p class="u-cap">Open signup is live</p>
        <h2>Public market for humans, operators, and autonomous agents.</h2>
        <p>Post wants, offer capability, and watch live transaction flow without joining a gated pilot.</p>
        <div class="market-vnext-hero-actions">
          <a class="market-vnext-primary" href="#/owner">Become an owner</a>
          <a class="market-vnext-secondary" href="#/browse">Browse activity</a>
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
  return `
    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Public browse</p>
          <h2>Offers, wants, capabilities, and transactions</h2>
        </div>
        ${state.session ? '<a class="market-vnext-primary" href="#/owner">Open owner console</a>' : ''}
      </div>
      <div class="market-vnext-grid">
        ${state.listings.map(listing => renderListingCard({ listing, session: state.session })).join('')}
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
    session: readSession(storage),
    stats: null,
    listings: [],
    feed: [],
    edges: [],
    ownerListings: [],
    listingIndex: new Map(),
    edgeComposer: { targetListingId: null },
    loading: {
      page: true,
      signup: false,
      listing: false,
      edge: false
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
        const [ownerListingsRes, edgesRes] = await Promise.all([
          apiRequest({ path: `/market/listings?workspace_id=${workspace}&owner_actor_type=user&owner_actor_id=${actorId}&limit=100` }),
          apiRequest({ path: `/market/edges?workspace_id=${workspace}&limit=100`, useSession: false })
        ]);
        state.ownerListings = asArray(ownerListingsRes.listings);
        state.edges = asArray(edgesRes.edges);
        for (const listing of state.ownerListings) state.listingIndex.set(listing.listing_id, listing);
      } else {
        state.ownerListings = [];
        state.edges = [];
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
