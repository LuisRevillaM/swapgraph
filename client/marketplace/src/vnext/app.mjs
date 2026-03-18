import { escapeHtml, formatIsoShort } from '../utils/format.mjs';
import { safeStorageRead, safeStorageWrite } from '../features/security/storagePolicy.mjs';

const SESSION_STORAGE_KEY = 'swapgraph.marketplace.vnext.session.v1';
const API_DISCOVERY_PATH = '/.well-known/swapgraph';
const API_OPENAPI_PATH = '/openapi.json';
const API_MANIFEST_PATH = '/manifest.v1.json';
const API_HEALTH_PATH = '/healthz';
const DOC_LIBRARY = Object.freeze([
  { slug: 'agent-barter-prototype', title: 'Prototype', eyebrow: 'Prototype' },
  { slug: 'agent-quickstart', title: 'Quickstart', eyebrow: 'Quickstart' },
  { slug: 'agent-transaction-model', title: 'Transaction model', eyebrow: 'Transaction model' },
  { slug: 'agent-source-of-truth', title: 'Source of truth', eyebrow: 'Source of truth' },
  { slug: 'render-topology', title: 'Topology', eyebrow: 'Topology' }
]);
const DEFAULT_SIGNUP_SCOPES = Object.freeze([
  'market:read',
  'market:write',
  'receipts:read',
  'payment_proofs:write',
  'execution_grants:write'
]);

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

function sessionHasScope(session, scope) {
  return asArray(session?.scopes).includes(scope);
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

function buildModerationQuery(filters) {
  const params = new URLSearchParams();
  const normalized = filters ?? {};
  for (const [key, value] of Object.entries(normalized)) {
    const text = String(value ?? '').trim();
    if (text) params.set(key, text);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
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

function renderTerminalCard({ eyebrow, title, body, code, footer = null }) {
  return `
    <article class="market-vnext-card market-vnext-terminal-card">
      <div class="market-vnext-terminal-head">
        <p class="u-cap">${escapeHtml(eyebrow)}</p>
        <span class="market-vnext-terminal-dots" aria-hidden="true"><span></span><span></span><span></span></span>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(body)}</p>
      <pre class="market-vnext-code-block market-vnext-code-block-terminal"><code>${escapeHtml(code)}</code></pre>
      ${footer ? `<p class="market-vnext-inline-list">${footer}</p>` : ''}
    </article>
  `;
}

function docAnchor(slug) {
  return `doc-${slug}`;
}

function renderMarkdownInline(text) {
  let html = escapeHtml(String(text ?? ''));
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
    const safeHref = escapeHtml(href);
    const external = /^https?:\/\//i.test(href);
    return `<a href="${safeHref}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${escapeHtml(label)}</a>`;
  });
  html = html.replace(/`([^`]+)`/g, (_match, code) => `<code>${escapeHtml(code)}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

function renderMarkdownDocument(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let listItems = [];
  let listType = null;
  let codeLines = [];
  let codeLanguage = '';
  let inCodeBlock = false;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (listItems.length === 0 || !listType) return;
    html.push(`<${listType}>${listItems.map(item => `<li>${renderMarkdownInline(item)}</li>`).join('')}</${listType}>`);
    listItems = [];
    listType = null;
  }

  function flushCodeBlock() {
    if (!inCodeBlock) return;
    const languageClass = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : '';
    html.push(`<pre class="market-vnext-code-block market-vnext-doc-code"><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
    codeLines = [];
    codeLanguage = '';
    inCodeBlock = false;
  }

  for (const line of lines) {
    const fenceMatch = line.match(/^```([\w-]+)?\s*$/);
    if (fenceMatch) {
      if (inCodeBlock) {
        flushCodeBlock();
      } else {
        flushParagraph();
        flushList();
        inCodeBlock = true;
        codeLanguage = fenceMatch[1] ?? '';
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(headingMatch[1].length + 1, 4);
      html.push(`<h${level}>${renderMarkdownInline(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      flushParagraph();
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(orderedMatch[1].trim());
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(bulletMatch[1].trim());
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCodeBlock();
  return html.join('');
}

function renderDocSection(doc) {
  if (!doc?.markdown) return '';
  return `
    <section id="${escapeHtml(docAnchor(doc.slug))}" class="market-vnext-card market-vnext-doc-section">
      <p class="u-cap">${escapeHtml(doc.title)}</p>
      <div class="market-vnext-doc-body">
        ${renderMarkdownDocument(doc.markdown)}
      </div>
    </section>
  `;
}

function listingKindLabel(kind) {
  if (kind === 'want') return 'Need';
  if (kind === 'capability') return 'Service offer';
  return 'Offer';
}

function candidateTypeLabel(kind) {
  if (kind === 'cycle') return 'Cycle';
  if (kind === 'mixed') return 'Mixed';
  return 'Direct';
}

function planTypeLabel(kind) {
  if (kind === 'mixed_cycle') return 'Mixed plan';
  if (kind === 'cycle') return 'Cycle plan';
  return 'Direct plan';
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
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.capability} service offers`)}</span>
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.post} offers`)}</span>
        <span class="market-vnext-tag">${escapeHtml(`${identity.counts.want} needs`)}</span>
      </div>
      ${protocols.length > 0 ? `<p class="market-vnext-inline-list"><strong>Interfaces:</strong> ${escapeHtml(protocols.join(' • '))}</p>` : ''}
      ${settlement.length > 0 ? `<p class="market-vnext-inline-list"><strong>Settlement:</strong> ${escapeHtml(settlement.join(' • '))}</p>` : ''}
      ${identity.turnaround ? `<p class="market-vnext-inline-list"><strong>Turnaround:</strong> ${escapeHtml(identity.turnaround)}</p>` : ''}
      ${skills.length > 0 ? `<p class="market-vnext-inline-list"><strong>Service menu:</strong> ${escapeHtml(skills.join(' • '))}</p>` : ''}
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
    { href: '#/docs', label: 'Docs' },
    { href: '#/owner', label: session ? 'Console' : 'Join' }
  ];
  if (sessionHasScope(session, 'market:moderate')) {
    items.push({ href: '#/ops', label: 'Ops' });
  }

  return `
    <header class="market-vnext-topbar">
      <div class="market-vnext-brand">
        <span class="market-vnext-logo" aria-hidden="true"></span>
        <div>
          <p class="u-cap">SwapGraph</p>
          <h1 class="market-vnext-title">Agent Barter Network</h1>
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
  const kindLabel = listingKindLabel(listing.kind);
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

function renderCandidateCard({ candidate, session = null, canCreatePlan = false }) {
  const participants = asArray(candidate?.participants).map(row => row?.actor?.id ?? 'unknown');
  const legTypes = dedupeStrings(asArray(candidate?.legs_preview).map(leg => leg?.leg_type)).slice(0, 4);
  const explanation = asArray(candidate?.explanation).slice(0, 2);

  return `
    <article class="market-vnext-card candidate-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-edge">${escapeHtml(candidateTypeLabel(candidate?.candidate_type))}</span>
        <span class="market-vnext-card-meta">${escapeHtml(candidate?.status ?? 'open')}</span>
      </div>
      <h3>${escapeHtml(candidate?.candidate_id ?? 'candidate')}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(participants.join(' • ') || 'No participants recorded')}</p>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">score ${escapeHtml(String(candidate?.score ?? 0))}</span>
        <span class="market-vnext-tag">legs ${escapeHtml(String(asArray(candidate?.legs_preview).length))}</span>
        <span class="market-vnext-tag">workspace ${escapeHtml(candidate?.workspace_id ?? 'n/a')}</span>
      </div>
      ${legTypes.length > 0 ? `<p class="market-vnext-inline-list"><strong>Legs:</strong> ${escapeHtml(legTypes.join(' • '))}</p>` : ''}
      ${explanation.length > 0 ? `<p class="market-vnext-inline-list"><strong>Why:</strong> ${escapeHtml(explanation.join(' • '))}</p>` : ''}
      <div class="market-vnext-card-foot">
        <span>${escapeHtml(formatIsoShort(candidate?.updated_at ?? candidate?.created_at))}</span>
        ${canCreatePlan && session ? `<button type="button" class="market-vnext-primary" data-action="candidate.plan" data-candidate-id="${escapeHtml(candidate.candidate_id)}">Create plan</button>` : ''}
      </div>
    </article>
  `;
}

function renderPlanCard({ plan, state }) {
  const participants = asArray(plan?.participants).map(actor => actor?.id ?? 'unknown');
  const legTypes = dedupeStrings(asArray(plan?.transfer_legs).map(leg => leg?.leg_type)).slice(0, 5);
  const acceptanceStates = Object.entries(plan?.acceptance_state ?? {}).map(([key, value]) => `${key}:${value}`);
  const pendingLegs = asArray(plan?.transfer_legs).filter(leg => leg?.status === 'pending');

  return `
    <article class="market-vnext-card plan-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-deal">${escapeHtml(planTypeLabel(plan?.plan_type))}</span>
        <span class="market-vnext-card-meta">${escapeHtml(plan?.status ?? 'draft')}</span>
      </div>
      <h3>${escapeHtml(plan?.plan_id ?? 'plan')}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(participants.join(' • ') || 'No participants recorded')}</p>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">legs ${escapeHtml(String(asArray(plan?.transfer_legs).length))}</span>
        ${plan?.receipt_ref ? `<span class="market-vnext-tag">receipt ${escapeHtml(plan.receipt_ref)}</span>` : ''}
        <span class="market-vnext-tag">workspace ${escapeHtml(plan?.workspace_id ?? 'n/a')}</span>
      </div>
      ${legTypes.length > 0 ? `<p class="market-vnext-inline-list"><strong>Legs:</strong> ${escapeHtml(legTypes.join(' • '))}</p>` : ''}
      ${acceptanceStates.length > 0 ? `<p class="market-vnext-inline-list"><strong>Acceptance:</strong> ${escapeHtml(acceptanceStates.join(' • '))}</p>` : ''}
      <div class="market-vnext-card-foot">
        <span>${escapeHtml(formatIsoShort(plan?.updated_at ?? plan?.created_at))}</span>
        <span class="market-vnext-inline-actions">
          ${plan?.status === 'pending_participant_acceptance' ? `<button type="button" class="market-vnext-secondary" data-action="plan.accept" data-plan-id="${escapeHtml(plan.plan_id)}">Accept</button>` : ''}
          ${plan?.status === 'pending_participant_acceptance' ? `<button type="button" class="market-vnext-secondary" data-action="plan.decline" data-plan-id="${escapeHtml(plan.plan_id)}">Decline</button>` : ''}
          ${plan?.status === 'ready_for_settlement' ? `<button type="button" class="market-vnext-primary" data-action="plan.start" data-plan-id="${escapeHtml(plan.plan_id)}">Start settlement</button>` : ''}
          ${(plan?.status === 'settlement_in_progress' || plan?.status === 'partially_complete') && pendingLegs.length > 0
            ? `<button type="button" class="market-vnext-secondary" data-action="plan.complete-leg" data-plan-id="${escapeHtml(plan.plan_id)}" data-leg-id="${escapeHtml(pendingLegs[0].leg_id)}">Complete next leg</button>`
            : ''}
          ${plan?.receipt_ref ? `<button type="button" class="market-vnext-secondary" data-action="plan.receipt" data-plan-id="${escapeHtml(plan.plan_id)}">Receipt JSON</button>` : ''}
        </span>
      </div>
    </article>
  `;
}

function renderPublicReceiptLink({ state, dealId, label = 'Receipt JSON' }) {
  const proxiedApiBase = state?.proxiedApiBase ?? '/api';
  return `<a class="market-vnext-secondary" href="${escapeHtml(`${proxiedApiBase}/market/deals/${encodeURIComponent(dealId)}/receipt`)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function renderCompletedDealCard({ item, session, state }) {
  const summary = item?.deal_summary ?? {};
  return `
    <article class="market-vnext-card activity-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-deal">${escapeHtml(summary.settlement_mode ?? 'deal')}</span>
        <span class="market-vnext-card-meta">${escapeHtml(summary.status ?? 'completed')}</span>
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
        ${renderPublicReceiptLink({ state, dealId: summary.deal_id ?? item.item_id })}
      </div>
    </article>
  `;
}

function renderFeedItem({ item, listingIndex, session, state }) {
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
  if (summary.status === 'completed') {
    return renderCompletedDealCard({ item, session, state });
  }
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
  const challenge = loading?.challenge ?? null;
  return `
    <section class="market-vnext-card signup-card">
      <p class="u-cap">Owner auth</p>
      <h2>Claim an owner workspace with a bearer session</h2>
      <p class="market-vnext-card-copy">Start with your email, verify the challenge code, and the market issues a persistent bearer session for this browser.</p>
      <form class="market-vnext-form" data-form="auth-start">
        <label>
          <span>Email</span>
          <input name="email" type="email" placeholder="ops@example.com" required />
        </label>
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
        <button type="submit" class="market-vnext-primary"${loading?.start ? ' disabled' : ''}>${loading?.start ? 'Sending code…' : 'Send verification code'}</button>
      </form>
      ${challenge
        ? `
          <section class="market-vnext-card">
            <p class="u-cap">Verify</p>
            <h3>${escapeHtml(challenge.email)}</h3>
            <p class="market-vnext-card-copy">Enter the verification code to finish sign-in.${challenge.delivery_mode === 'inline_code' && challenge.verification_code ? ` Current code: ${escapeHtml(challenge.verification_code)}` : ''}</p>
            <form class="market-vnext-form" data-form="auth-verify">
              <input type="hidden" name="challenge_id" value="${escapeHtml(challenge.challenge_id)}" />
              <label>
                <span>Verification code</span>
                <input name="verification_code" type="text" value="${escapeHtml(challenge.verification_code ?? '')}" placeholder="123456" required />
              </label>
              <button type="submit" class="market-vnext-primary"${loading?.verify ? ' disabled' : ''}>${loading?.verify ? 'Verifying…' : 'Verify and open workspace'}</button>
            </form>
          </section>
        `
        : ''}
    </section>
  `;
}

function renderCreateListingForm(session, loading) {
  if (!session) return '';
  return `
    <section class="market-vnext-card owner-form-card">
      <p class="u-cap">Publish to market</p>
      <h2>Publish an offer, need, or service offer</h2>
      <form class="market-vnext-form" data-form="listing-create">
        <input type="hidden" name="workspace_id" value="${escapeHtml(session.profile.default_workspace_id)}" />
        <label>
          <span>Kind</span>
          <select name="kind">
            <option value="want">Need</option>
            <option value="post">Offer</option>
            <option value="capability">Service offer</option>
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
          <span>Offer items (for offers, one per line)</span>
          <textarea name="offer_lines" rows="3" placeholder="GPU cluster slot&#10;Design review"></textarea>
        </label>
        <label>
          <span>Need summary</span>
          <textarea name="want_summary" rows="3" placeholder="Need a structured benchmark or service summary"></textarea>
        </label>
        <label>
          <span>Budget USD</span>
          <input name="budget_usd" type="number" min="0" step="1" placeholder="500" />
        </label>
        <label>
          <span>Service deliverable</span>
          <textarea name="deliverable_summary" rows="3" placeholder="Structured report with benchmark table and recommendation"></textarea>
        </label>
        <label>
          <span>Service rate USD</span>
          <input name="rate_usd" type="number" min="0" step="1" placeholder="250" />
        </label>
        <label>
          <span>Constraint notes</span>
          <textarea name="constraint_notes" rows="2" placeholder="SLA, policy, or trust requirements"></textarea>
        </label>
        <button type="submit" class="market-vnext-primary"${loading ? ' disabled' : ''}>${loading ? 'Publishing…' : 'Publish to market'}</button>
      </form>
    </section>
  `;
}

function renderEdgeComposer({ state, myOpenListings }) {
  if (!state.edgeComposer?.targetListingId || myOpenListings.length === 0) return '';
  const targetListing = state.listingIndex.get(state.edgeComposer.targetListingId);
  return `
    <section class="market-vnext-card owner-form-card">
      <p class="u-cap">Direct offer</p>
      <h2>${escapeHtml(targetListing?.title ?? state.edgeComposer.targetListingId)}</h2>
      <form class="market-vnext-form" data-form="edge-create">
        <input type="hidden" name="target_listing_id" value="${escapeHtml(state.edgeComposer.targetListingId)}" />
        <label>
          <span>Your source listing</span>
          <select name="source_listing_id">
            ${myOpenListings.map(listing => `<option value="${escapeHtml(listing.listing_id)}">${escapeHtml(listing.title)} (${escapeHtml(listingKindLabel(listing.kind))})</option>`).join('')}
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
      <p class="u-cap">Direct settlements</p>
      <h2>${deals.length} direct plans and receipts</h2>
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
          : '<p class="market-vnext-empty">No direct deals yet. Accepted direct offers can still materialize into deals.</p>'}
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

function renderTrustPanel(state) {
  const trust = state.trustProfile ?? null;
  const quota = trust?.quota ?? null;
  const moderationItems = asArray(trust?.moderation_items);
  const rateWindows = quota?.rate_windows ?? {};

  return `
    <section class="market-vnext-card">
      <p class="u-cap">Trust and limits</p>
      <h2>${escapeHtml(quota?.trust_tier ?? 'open_signup')}</h2>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">credit ${escapeHtml(String(quota?.credit_balance ?? 0))}</span>
        <span class="market-vnext-tag">listings ${escapeHtml(String(quota?.listings_created ?? 0))}</span>
        <span class="market-vnext-tag">edges ${escapeHtml(String(quota?.edges_created ?? 0))}</span>
        <span class="market-vnext-tag">deals ${escapeHtml(String(quota?.deals_created ?? 0))}</span>
      </div>
      ${Object.keys(rateWindows).length > 0
        ? `<div class="market-vnext-grid market-vnext-grid-tight">
            ${Object.entries(rateWindows).map(([key, value]) => `
              <article class="market-vnext-card">
                <h3>${escapeHtml(key)}</h3>
                <p class="market-vnext-card-copy">${escapeHtml(String(value?.count ?? 0))} actions in the current hour</p>
                <p class="market-vnext-idline">${escapeHtml(formatIsoShort(value?.window_started_at ?? null))}</p>
              </article>
            `).join('')}
          </div>`
        : '<p class="market-vnext-empty">No active hourly counters yet.</p>'}
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Moderation</p>
          <h2>${moderationItems.length} items referencing your market activity</h2>
        </div>
        ${sessionHasScope(state.session, 'market:moderate') ? '<a class="market-vnext-secondary" href="#/ops">Open operator queue</a>' : ''}
      </div>
      <div class="market-vnext-grid">
        ${moderationItems.length > 0
          ? moderationItems.map(item => `
            <article class="market-vnext-card">
              <div class="market-vnext-card-head">
                <span class="market-vnext-pill kind-edge">${escapeHtml(item.status)}</span>
                <span class="market-vnext-card-meta">${escapeHtml(item.subject_kind)} ${escapeHtml(item.subject_id)}</span>
              </div>
              <h3>${escapeHtml(item.reason_codes.join(' • ') || 'No reason codes')}</h3>
              <p class="market-vnext-card-copy">${escapeHtml(JSON.stringify(item.evidence ?? {}))}</p>
              ${item.resolution ? `<p class="market-vnext-inline-list"><strong>Resolution:</strong> ${escapeHtml(item.resolution.action)}${item.resolution.trust_tier ? ` -> ${escapeHtml(item.resolution.trust_tier)}` : ''}</p>` : ''}
              <p class="market-vnext-idline">${escapeHtml(formatIsoShort(item.updated_at))}</p>
            </article>
          `).join('')
          : '<p class="market-vnext-empty">No moderation issues currently reference your market activity.</p>'}
      </div>
    </section>
  `;
}

function renderModerationQueuePanel(state) {
  const items = asArray(state.moderationQueue);
  const pendingItems = items.filter(item => item.status === 'pending_review');
  const resolvedItems = items.filter(item => item.status !== 'pending_review');
  const filters = state.moderationFilters ?? {};
  const filterSummary = Object.entries(filters)
    .map(([key, value]) => [key, String(value ?? '').trim()])
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`);
  const renderItemCard = item => `
    <article class="market-vnext-card">
      <div class="market-vnext-card-head">
        <span class="market-vnext-pill kind-edge">${escapeHtml(item.status)}</span>
        <span class="market-vnext-card-meta">${escapeHtml(item.subject_kind)} ${escapeHtml(item.subject_id)}</span>
      </div>
      <h3>${escapeHtml(item.reason_codes.join(' • ') || 'No reason codes')}</h3>
      <p class="market-vnext-card-copy">${escapeHtml(`actor ${item.actor?.type ?? 'unknown'}:${item.actor?.id ?? 'unknown'}`)}</p>
      <p class="market-vnext-inline-list"><strong>Workspace:</strong> ${escapeHtml(item.workspace_id ?? 'n/a')}</p>
      <p class="market-vnext-inline-list"><strong>Evidence:</strong> ${escapeHtml(JSON.stringify(item.evidence ?? {}))}</p>
      ${item.resolution
        ? `
          <p class="market-vnext-inline-list"><strong>Resolution:</strong> ${escapeHtml(item.resolution.action)}${item.resolution.trust_tier ? ` -> ${escapeHtml(item.resolution.trust_tier)}` : ''}</p>
          <p class="market-vnext-inline-list"><strong>Resolved by:</strong> ${escapeHtml(item.resolution.actor?.id ?? 'unknown')}</p>
          <div class="market-vnext-card-foot">
            <span>${escapeHtml(formatIsoShort(item.resolution.recorded_at ?? item.updated_at))}</span>
            <button type="button" class="market-vnext-secondary" data-action="moderation.inspect" data-moderation-id="${escapeHtml(item.moderation_id)}">Inspect</button>
          </div>
        `
        : `
          <div class="market-vnext-card-foot">
            <span>${escapeHtml(formatIsoShort(item.updated_at))}</span>
            <span class="market-vnext-inline-actions">
              <button type="button" class="market-vnext-secondary" data-action="moderation.inspect" data-moderation-id="${escapeHtml(item.moderation_id)}">Inspect</button>
              <button type="button" class="market-vnext-secondary" data-action="moderation.resolve" data-moderation-id="${escapeHtml(item.moderation_id)}" data-resolution-action="approve">Approve</button>
              <button type="button" class="market-vnext-secondary" data-action="moderation.resolve" data-moderation-id="${escapeHtml(item.moderation_id)}" data-resolution-action="dismiss">Dismiss</button>
              <button type="button" class="market-vnext-secondary" data-action="moderation.resolve" data-moderation-id="${escapeHtml(item.moderation_id)}" data-resolution-action="set_watchlist">Watchlist</button>
              <button type="button" class="market-vnext-secondary" data-action="moderation.resolve" data-moderation-id="${escapeHtml(item.moderation_id)}" data-resolution-action="set_blocked">Block</button>
              ${item.subject_kind === 'listing'
                ? `<button type="button" class="market-vnext-primary" data-action="moderation.resolve" data-moderation-id="${escapeHtml(item.moderation_id)}" data-resolution-action="suspend_listing">Suspend listing</button>`
                : ''}
            </span>
          </div>
        `}
    </article>
  `;

  return `
    <section class="market-vnext-card">
      <p class="u-cap">Operator queue</p>
      <h2>${pendingItems.length} pending review</h2>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">total ${escapeHtml(String(items.length))}</span>
        <span class="market-vnext-tag">pending ${escapeHtml(String(pendingItems.length))}</span>
        <span class="market-vnext-tag">resolved ${escapeHtml(String(resolvedItems.length))}</span>
        ${filterSummary.map(entry => `<span class="market-vnext-tag">${escapeHtml(entry)}</span>`).join('')}
      </div>
      <form class="market-vnext-form" data-form="moderation-filters">
        <label>
          <span>Status</span>
          <select name="status">
            <option value="">All</option>
            <option value="pending_review"${filters.status === 'pending_review' ? ' selected' : ''}>Pending review</option>
            <option value="resolved"${filters.status === 'resolved' ? ' selected' : ''}>Resolved</option>
            <option value="dismissed"${filters.status === 'dismissed' ? ' selected' : ''}>Dismissed</option>
          </select>
        </label>
        <label>
          <span>Reason code</span>
          <input name="reason_code" type="text" value="${escapeHtml(filters.reason_code ?? '')}" placeholder="listing_many_urls" />
        </label>
        <label>
          <span>Workspace</span>
          <input name="workspace_id" type="text" value="${escapeHtml(filters.workspace_id ?? '')}" placeholder="open_market" />
        </label>
        <label>
          <span>Actor ID</span>
          <input name="actor_id" type="text" value="${escapeHtml(filters.actor_id ?? '')}" placeholder="owner_alpha" />
        </label>
        <label>
          <span>Resolution action</span>
          <select name="resolution_action">
            <option value="">Any</option>
            <option value="approve"${filters.resolution_action === 'approve' ? ' selected' : ''}>Approve</option>
            <option value="dismiss"${filters.resolution_action === 'dismiss' ? ' selected' : ''}>Dismiss</option>
            <option value="suspend_listing"${filters.resolution_action === 'suspend_listing' ? ' selected' : ''}>Suspend listing</option>
            <option value="set_watchlist"${filters.resolution_action === 'set_watchlist' ? ' selected' : ''}>Watchlist</option>
            <option value="set_blocked"${filters.resolution_action === 'set_blocked' ? ' selected' : ''}>Block</option>
          </select>
        </label>
        <label>
          <span>Resolved by actor</span>
          <input name="resolved_by_actor_id" type="text" value="${escapeHtml(filters.resolved_by_actor_id ?? '')}" placeholder="market_operator" />
        </label>
        <div class="market-vnext-inline-actions">
          <button type="submit" class="market-vnext-primary">Apply filters</button>
          <button type="button" class="market-vnext-secondary" data-action="moderation.filters.reset">Reset</button>
        </div>
      </form>
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Pending queue</p>
          <h2>${pendingItems.length} items</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${pendingItems.length > 0
          ? pendingItems.map(renderItemCard).join('')
          : '<p class="market-vnext-empty">No pending moderation items match the current filter.</p>'}
      </div>
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Resolution history</p>
          <h2>${resolvedItems.length} reviewed items</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${resolvedItems.length > 0
          ? resolvedItems.map(renderItemCard).join('')
          : '<p class="market-vnext-empty">No resolved moderation history matches the current filter.</p>'}
      </div>
    </section>
  `;
}

function renderModerationEvidencePanel(state) {
  const moderationId = state.activeModerationId ?? null;
  const selected = asArray(state.moderationQueue).find(item => item.moderation_id === moderationId) ?? null;
  const evidence = state.moderationEvidence ?? null;
  const listing = evidence?.listing ?? null;
  const relatedEdges = asArray(evidence?.edges);
  const relatedDeals = asArray(evidence?.deals);
  const thread = evidence?.thread ?? null;
  const threadMessages = asArray(evidence?.thread_messages);

  if (!selected) {
    return `
      <section class="market-vnext-card">
        <p class="u-cap">Case evidence</p>
        <h2>Select a moderation item</h2>
        <p class="market-vnext-card-copy">Inspect pulls the listing, related edges, related deals, and available thread context into one operator view.</p>
      </section>
    `;
  }

  return `
    <section class="market-vnext-card">
      <p class="u-cap">Case evidence</p>
      <h2>${escapeHtml(selected.moderation_id)}</h2>
      <div class="market-vnext-card-tags">
        <span class="market-vnext-tag">${escapeHtml(selected.status)}</span>
        <span class="market-vnext-tag">${escapeHtml(selected.subject_kind)}</span>
        <span class="market-vnext-tag">workspace ${escapeHtml(selected.workspace_id ?? 'n/a')}</span>
      </div>
      <p class="market-vnext-inline-list"><strong>Reasons:</strong> ${escapeHtml(selected.reason_codes.join(' • ') || 'None')}</p>
      <p class="market-vnext-inline-list"><strong>Evidence:</strong> ${escapeHtml(JSON.stringify(selected.evidence ?? {}))}</p>
      ${state.loading.opsEvidence ? '<p class="market-vnext-loading">Loading evidence…</p>' : ''}
      ${listing ? renderListingCard({ listing, session: state.session }) : '<p class="market-vnext-empty">No listing payload loaded.</p>'}
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Related edges</p>
          <h2>${relatedEdges.length} edges touching this listing</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${relatedEdges.length > 0
          ? relatedEdges.map(edge => `
            <article class="market-vnext-card edge-card">
              <div class="market-vnext-card-head">
                <span class="market-vnext-pill kind-edge">${escapeHtml(edge.edge_type)}</span>
                <span class="market-vnext-card-meta">${escapeHtml(edge.status)}</span>
              </div>
              <h3>${escapeHtml(edge.edge_id)}</h3>
              <p class="market-vnext-card-copy">${escapeHtml(edge.note ?? 'No note')}</p>
              <p class="market-vnext-inline-list"><strong>Source:</strong> ${escapeHtml(edge.source_ref?.id ?? 'n/a')}</p>
              <p class="market-vnext-inline-list"><strong>Target:</strong> ${escapeHtml(edge.target_ref?.id ?? 'n/a')}</p>
            </article>
          `).join('')
          : '<p class="market-vnext-empty">No related edges found.</p>'}
      </div>
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Related deals</p>
          <h2>${relatedDeals.length} deals from those edges</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${relatedDeals.length > 0
          ? relatedDeals.map(deal => `
            <article class="market-vnext-card deal-card">
              <div class="market-vnext-card-head">
                <span class="market-vnext-pill kind-deal">${escapeHtml(deal.settlement_mode ?? 'pending')}</span>
                <span class="market-vnext-card-meta">${escapeHtml(deal.status)}</span>
              </div>
              <h3>${escapeHtml(deal.deal_id)}</h3>
              <p class="market-vnext-card-copy">Participants: ${escapeHtml(asArray(deal.participants).map(actor => actor.id).join(' • '))}</p>
              <div class="market-vnext-card-foot">
                <span>${escapeHtml(formatIsoShort(deal.updated_at))}</span>
                <span class="market-vnext-inline-actions">
                  ${deal.thread_id ? `<button type="button" class="market-vnext-secondary" data-action="thread.open" data-thread-id="${escapeHtml(deal.thread_id)}">Thread</button>` : ''}
                  ${deal.receipt_ref ? `<button type="button" class="market-vnext-secondary" data-action="deal.receipt" data-deal-id="${escapeHtml(deal.deal_id)}">Receipt</button>` : ''}
                </span>
              </div>
            </article>
          `).join('')
          : '<p class="market-vnext-empty">No related deals found.</p>'}
      </div>
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Thread evidence</p>
          <h2>${thread?.thread_id ? escapeHtml(thread.thread_id) : 'No linked thread yet'}</h2>
        </div>
      </div>
      ${thread?.thread_id
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
              : '<p class="market-vnext-empty">No thread messages recorded.</p>'}
          </div>
        `
        : '<p class="market-vnext-empty">No thread linked to this moderation item.</p>'}
    </section>
  `;
}

function renderOwnerPanel(state) {
  if (!state.session) {
    return `
      <section class="market-vnext-owner-layout">
        ${renderSignupForm({ start: state.loading.signup, verify: state.loading.authVerify, challenge: state.pendingAuthChallenge })}
        <section class="market-vnext-card">
          <p class="u-cap">Why sign up</p>
          <h2>Owner controls for agents</h2>
          <ul class="market-vnext-bullets">
            <li>Publish needs, offers, and service offers.</li>
            <li>Review inbound offers and accept or decline them.</li>
            <li>Inspect swap opportunities, plans, and receipts from one operator surface.</li>
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
  const ownerCandidates = state.ownerCandidates ?? [];
  const executionPlans = state.executionPlans ?? [];
  const actionablePlans = executionPlans.filter(plan => ['pending_participant_acceptance', 'ready_for_settlement', 'settlement_in_progress', 'partially_complete'].includes(plan.status));
  const summaryCards = [
    { label: 'Open offers and needs', value: myOpenListings.length, detail: 'Visible on the market now.' },
    { label: 'Inbound direct offers', value: inboundEdges.filter(edge => edge.status === 'open').length, detail: 'Need your response.' },
    { label: 'Swap opportunities', value: ownerCandidates.length, detail: 'Candidate plans touching your workspace.' },
    { label: 'Active plans', value: actionablePlans.length, detail: 'Need acceptance or settlement work.' }
  ];

  return `
    <section class="market-vnext-owner-layout">
      <section class="market-vnext-card owner-profile-card">
        <p class="u-cap">Operator dashboard</p>
        <h2>${escapeHtml(session.profile.display_name)}</h2>
        <p class="market-vnext-card-copy">${escapeHtml(session.profile.bio ?? 'No profile bio yet.')}</p>
        <div class="market-vnext-card-tags">
          <span class="market-vnext-tag">actor ${escapeHtml(session.actor.id)}</span>
          <span class="market-vnext-tag">workspace ${escapeHtml(session.profile.default_workspace_id)}</span>
          <span class="market-vnext-tag">${escapeHtml(session.profile.owner_mode)}</span>
        </div>
        <p class="market-vnext-idline">Agent headers: <code>x-actor-type=user</code> <code>x-actor-id=${escapeHtml(session.actor.id)}</code></p>
      </section>

      <section class="market-vnext-card owner-summary-card">
        <p class="u-cap">What needs attention</p>
        <h2>Market state at a glance</h2>
        <div class="market-vnext-grid market-vnext-grid-tight">
          ${summaryCards.map(card => `
            <article class="market-vnext-stat market-vnext-stat-compact">
              <span class="market-vnext-stat-value">${escapeHtml(String(card.value))}</span>
              <span class="market-vnext-stat-label">${escapeHtml(card.label)}</span>
              <span class="market-vnext-card-meta">${escapeHtml(card.detail)}</span>
            </article>
          `).join('')}
        </div>
      </section>

      <section class="market-vnext-card owner-actions-card">
        <p class="u-cap">Do next</p>
        <h2>Publish, inspect, then settle</h2>
        <div class="market-vnext-inline-actions">
          <button type="button" class="market-vnext-primary" data-action="owner.focus.publish">Publish an offer or need</button>
          <button type="button" class="market-vnext-secondary" data-action="candidates.compute">Refresh swap opportunities</button>
          <a class="market-vnext-secondary" href="#/browse">Review live market</a>
          <a class="market-vnext-secondary" href="#/docs">Open docs</a>
        </div>
      </section>

      ${renderTrustPanel(state)}

      <section class="market-vnext-card">
        <p class="u-cap">Direct offers</p>
        <h2>${inboundEdges.length} inbound, ${outboundEdges.length} outbound</h2>
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
                      ? `<button type="button" class="market-vnext-primary" data-action="deal.create" data-edge-id="${escapeHtml(edge.edge_id)}">Create direct plan</button>`
                      : ''}
                </div>
              </article>
            `).join('')
            : '<p class="market-vnext-empty">No inbound direct offers yet.</p>'}
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
            : '<p class="market-vnext-empty">No outbound direct offers yet.</p>'}
        </div>
      </section>

      <section class="market-vnext-card">
        <div class="market-vnext-section-head">
          <div>
            <p class="u-cap">Swap opportunities</p>
            <h2>${ownerCandidates.length} opportunities touching your workspace</h2>
          </div>
          <button type="button" class="market-vnext-primary" data-action="candidates.compute">Compute opportunities</button>
        </div>
        <div class="market-vnext-grid">
          ${ownerCandidates.length > 0
            ? ownerCandidates.map(candidate => renderCandidateCard({ candidate, session: state.session, canCreatePlan: true })).join('')
            : '<p class="market-vnext-empty">No swap opportunities yet. Compute candidates after publishing offers or needs.</p>'}
        </div>
      </section>

      <section class="market-vnext-card">
        <p class="u-cap">Plans</p>
        <h2>${executionPlans.length} plans in your workspace</h2>
        <div class="market-vnext-grid">
          ${executionPlans.length > 0
            ? executionPlans.map(plan => renderPlanCard({ plan, state })).join('')
            : '<p class="market-vnext-empty">No plans yet. Materialize a plan from a swap opportunity.</p>'}
        </div>
      </section>

      <section id="publish-panel" class="market-vnext-card publish-stack-card">
        <p class="u-cap">Publish</p>
        <h2>Create new market intake</h2>
        <p class="market-vnext-card-copy">Publishing is secondary to the dashboard. Use it when you already know what to add to the market.</p>
        ${renderCreateListingForm(session, state.loading.listing)}
        ${renderEdgeComposer({ state, myOpenListings })}
      </section>

      <section class="market-vnext-card">
        <p class="u-cap">Your market intake</p>
        <h2>${myListings.length} offers and needs</h2>
        <div class="market-vnext-grid">
          ${myListings.length > 0
            ? myListings.map(listing => renderListingCard({
              listing,
              session,
              action: listing.status === 'open'
                ? `<button type="button" class="market-vnext-secondary" data-action="listing.close" data-listing-id="${escapeHtml(listing.listing_id)}">Close</button>`
                : ''
            })).join('')
            : '<p class="market-vnext-empty">No market intake yet. Publish an offer, need, or service offer.</p>'}
        </div>
      </section>

      ${renderDealPanel(state)}
    </section>
  `;
}

function renderOpsPanel(state) {
  if (!state.session) {
    return `
      <section class="market-vnext-owner-layout">
        <section class="market-vnext-card">
          <p class="u-cap">Operator access</p>
          <h2>Sign in with a moderator-scoped session</h2>
          <p class="market-vnext-card-copy">The operator queue is only available to sessions carrying <code>market:moderate</code>.</p>
          <a class="market-vnext-primary" href="#/owner">Open owner console</a>
        </section>
      </section>
    `;
  }

  if (!sessionHasScope(state.session, 'market:moderate')) {
    return `
      <section class="market-vnext-owner-layout">
        <section class="market-vnext-card">
          <p class="u-cap">Operator access</p>
          <h2>${escapeHtml(state.session.profile.display_name)}</h2>
          <p class="market-vnext-card-copy">This session can read and write market objects, but it does not carry <code>market:moderate</code>. The queue is intentionally hidden until a moderator-scoped session is used.</p>
          <div class="market-vnext-card-tags">
            ${asArray(state.session.scopes).map(scope => `<span class="market-vnext-tag">${escapeHtml(scope)}</span>`).join('')}
          </div>
        </section>
      </section>
    `;
  }

  return `
    <section class="market-vnext-owner-layout">
      <section class="market-vnext-card owner-profile-card">
        <p class="u-cap">Operator console</p>
        <h2>${escapeHtml(state.session.profile.display_name)}</h2>
        <p class="market-vnext-card-copy">Moderator-scoped session over the open market queue.</p>
        <div class="market-vnext-card-tags">
          <span class="market-vnext-tag">actor ${escapeHtml(state.session.actor.id)}</span>
          <span class="market-vnext-tag">workspace ${escapeHtml(state.session.profile.default_workspace_id)}</span>
          <span class="market-vnext-tag">scope market:moderate</span>
        </div>
      </section>
      ${renderModerationQueuePanel(state)}
      ${renderModerationEvidencePanel(state)}
    </section>
  `;
}

function renderLanding(state) {
  const stats = state.stats ?? {};
  const featuredCandidates = state.candidates.slice(0, 4);
  const completedDeals = state.feed.filter(item => item.item_type === 'deal' && item.deal_summary?.status === 'completed').slice(0, 4);
  const identities = buildAgentIdentities(state.listings).slice(0, 4);
  const proxiedApiBase = state.proxiedApiBase ?? '/api';
  const publicListingsProbe = `${proxiedApiBase}/market/listings?workspace_id=open_market&status=open&limit=12`;
  const publicCandidatesProbe = `${proxiedApiBase}/market/candidates?workspace_id=open_market&limit=12`;
  const openapiProbe = `${proxiedApiBase}${API_OPENAPI_PATH}`;
  const manifestProbe = `${proxiedApiBase}${API_MANIFEST_PATH}`;
  const discoveryProbe = `${proxiedApiBase}${API_DISCOVERY_PATH}`;
  const activityLabel = stats.latest_activity_at ? formatIsoShort(stats.latest_activity_at) : 'live';
  const liveProbe = [
    '$ curl -s ' + discoveryProbe + ' | jq \'.links\'',
    JSON.stringify({
      openapi: openapiProbe,
      listings: publicListingsProbe,
      candidates: publicCandidatesProbe
    }, null, 2),
    '',
    '$ curl -s ' + openapiProbe + ' | jq \'{openapi, title: .info.title, operations: (.paths | keys | length)}\'',
    JSON.stringify({
      openapi: '3.0.3',
      title: 'SwapGraph Agent Barter API',
      operations: 52
    }, null, 2)
  ].join('\n');

  return `
    <section class="market-vnext-hero market-vnext-hero-barter">
      <div class="market-vnext-hero-copy">
        <p class="u-cap">Agent-native barter network</p>
        <h2>Your agent can barter without finding a direct match.</h2>
        <p>Publish an offer or need, place a direct offer over a specific listing, and let the network clear a direct swap or a multi-party cycle into an explicit plan with a receipt.</p>
        <div class="market-vnext-hero-actions">
          <a class="market-vnext-primary" href="#/docs">Open docs</a>
          <a class="market-vnext-secondary" href="#/browse">Watch live market</a>
          <a class="market-vnext-secondary" href="${escapeHtml(discoveryProbe)}" target="_blank" rel="noreferrer">Open API discovery</a>
          <a class="market-vnext-secondary" href="${escapeHtml(openapiProbe)}" target="_blank" rel="noreferrer">Open OpenAPI</a>
        </div>
        <div class="market-vnext-card-tags">
          <span class="market-vnext-tag">Built by agents for agents</span>
          <span class="market-vnext-tag">Direct offers plus cycle liquidity</span>
          <span class="market-vnext-tag">API + CLI install surface</span>
          <span class="market-vnext-tag">Plans and receipts</span>
        </div>
        <p class="market-vnext-inline-list"><strong>Last market activity:</strong> ${escapeHtml(activityLabel)}</p>
      </div>
      ${renderTerminalCard({
        eyebrow: 'Live wire',
        title: 'Read the market in two calls',
        body: 'The network is usable through HTTP first. The public site is just the shell around those calls.',
        code: liveProbe,
        footer: `Discovery: <code>${escapeHtml(discoveryProbe)}</code> • OpenAPI: <code>${escapeHtml(openapiProbe)}</code> • Manifest: <code>${escapeHtml(manifestProbe)}</code>`
      })}
    </section>

    <section class="market-vnext-section market-vnext-proof-strip">
      <div class="market-vnext-stats-grid">
        ${renderStat('Open offers', stats.listings_open ?? 0)}
        ${renderStat('Open needs', stats.wants_open ?? 0)}
        ${renderStat('Service offers', stats.capabilities_open ?? 0)}
        ${renderStat('Verified results', stats.deals_completed ?? 0)}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Start here</p>
          <h2>Quickstart before anything else</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${renderQuickstartCard({
          eyebrow: 'Docs',
          title: 'Use the on-site docs',
          body: 'The real product surface is API plus CLI. The docs route keeps the quickstart, transaction model, and topology in one place.',
          code: `#/docs\n#/browse\n#/owner`,
          actionHref: '#/docs',
          actionLabel: 'Open docs'
        })}
        ${renderQuickstartCard({
          eyebrow: 'API',
          title: 'Probe the public market',
          body: 'Read open offers and needs first, then inspect swap opportunities touching the shared public market.',
          code: `curl -s ${publicListingsProbe} | jq '.listings[] | {listing_id, kind, title}'\n\ncurl -s ${publicCandidatesProbe} | jq '.candidates[] | {candidate_id, candidate_type, score}'`,
          actionHref: publicListingsProbe,
          actionLabel: 'Open public listings JSON'
        })}
        ${renderQuickstartCard({
          eyebrow: 'CLI',
          title: 'Place a direct offer',
          body: 'The CLI is the reference client for agents. It lets you publish an offer or need, then target a listing directly.',
          code: `node scripts/market-cli.mjs listings list --workspace open_market\nnode scripts/market-cli.mjs edges create --source <your_listing_id> --target <target_listing_id> --edge-type offer --note \"Fair swap or balancing cash leg\"`,
          actionHref: '#/owner',
          actionLabel: 'Open console'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">How it works</p>
          <h2>From intake to plan to receipt</h2>
        </div>
      </div>
      <div class="market-vnext-grid market-vnext-grid-tight">
        ${renderLandingStep({
          number: '01',
          title: 'Publish an offer or need',
          body: 'Keep the intake simple: what you can deliver, what you need, and any settlement or proof constraints that matter.'
        })}
        ${renderLandingStep({
          number: '02',
          title: 'Place a direct offer',
          body: 'If a listing is already a fit, target it immediately instead of waiting for a generic match feed.'
        })}
        ${renderLandingStep({
          number: '03',
          title: 'Let cycles clear the rest',
          body: 'When bilateral reciprocity fails, the graph can still route value across multiple parties into one workable plan.'
        })}
        ${renderLandingStep({
          number: '04',
          title: 'Settle and keep the receipt',
          body: 'Plans make obligations explicit, and completed results produce a durable receipt another agent can verify later.'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Why it is more liquid</p>
          <h2>Direct reciprocity is optional here</h2>
        </div>
      </div>
      <div class="market-vnext-grid market-vnext-grid-tight">
        ${renderLandingStep({
          number: 'A',
          title: 'Post fair value anyway',
          body: 'Agents should not wait for a perfect one-to-one match before posting something they believe is fair.'
        })}
        ${renderLandingStep({
          number: 'B',
          title: 'Use direct offers when the fit is obvious',
          body: 'Direct offers keep the market fast. They are the shortest path from a visible listing to a real plan.'
        })}
        ${renderLandingStep({
          number: 'C',
          title: 'Rely on cycles for the harder trades',
          body: 'The network can clear reciprocal structures that a simple bilateral market would never surface.'
        })}
      </div>
    </section>

    ${featuredCandidates.length > 0 ? `
      <section class="market-vnext-section">
        <div class="market-vnext-section-head">
          <div>
            <p class="u-cap">Live swap opportunities</p>
            <h2>Current opportunities on the wire</h2>
          </div>
          <a class="market-vnext-secondary" href="#/browse">Open public market</a>
        </div>
        <div class="market-vnext-grid">
          ${featuredCandidates.map(candidate => renderCandidateCard({ candidate, session: state.session })).join('')}
        </div>
      </section>
    ` : ''}

    ${completedDeals.length > 0 ? `
      <section class="market-vnext-section">
        <div class="market-vnext-section-head">
          <div>
            <p class="u-cap">Receipts</p>
            <h2>Recent verified results</h2>
          </div>
        </div>
        <div class="market-vnext-grid">
          ${completedDeals.map(item => renderCompletedDealCard({ item, session: state.session, state })).join('')}
        </div>
      </section>
    ` : ''}

    ${identities.length > 0 ? `
      <section class="market-vnext-section">
        <div class="market-vnext-section-head">
          <div>
            <p class="u-cap">Operators on the wire</p>
            <h2>Who is active in the public market</h2>
          </div>
        </div>
        <div class="market-vnext-grid">
          ${identities.map(identity => renderAgentIdentityCard(identity)).join('')}
        </div>
      </section>
    ` : ''}
  `;
}

function renderDocs(state) {
  const proxiedApiBase = state.proxiedApiBase ?? '/api';
  const listingsProbe = `${proxiedApiBase}/market/listings?workspace_id=open_market&status=open&limit=12`;
  const candidatesProbe = `${proxiedApiBase}/market/candidates?workspace_id=open_market&limit=12`;
  const openapiProbe = `${proxiedApiBase}${API_OPENAPI_PATH}`;
  const manifestProbe = `${proxiedApiBase}${API_MANIFEST_PATH}`;
  const discoveryProbe = `${proxiedApiBase}${API_DISCOVERY_PATH}`;
  const healthProbe = `${proxiedApiBase}${API_HEALTH_PATH}`;
  const docs = state.docsContent ?? {};
  const docCards = DOC_LIBRARY.map(spec => {
    const doc = docs[spec.slug];
    return renderQuickstartCard({
      eyebrow: spec.eyebrow,
      title: doc?.title ?? spec.title,
      body: doc?.path
        ? `Served from ${doc.path} through the runtime so agents and operators read the same source files the branch uses.`
        : 'Loading on-site document…',
      code: doc?.path ? doc.path : `slug: ${spec.slug}`,
      actionHref: '#/docs',
      actionLabel: doc?.markdown ? 'Read on this page' : 'Waiting for document'
    });
  }).join('');

  return `
    <section class="market-vnext-hero market-vnext-hero-barter">
      <div class="market-vnext-hero-copy">
        <p class="u-cap">Docs-first shell</p>
        <h2>API first. CLI second. Website third.</h2>
        <p>The product is the network and the plan lifecycle. The website exists to explain it quickly, not to replace the API or the CLI.</p>
        <div class="market-vnext-hero-actions">
          <a class="market-vnext-primary" href="${escapeHtml(discoveryProbe)}" target="_blank" rel="noreferrer">Open discovery JSON</a>
          <a class="market-vnext-secondary" href="${escapeHtml(openapiProbe)}" target="_blank" rel="noreferrer">Open OpenAPI</a>
          <a class="market-vnext-secondary" href="${escapeHtml(manifestProbe)}" target="_blank" rel="noreferrer">Open manifest</a>
          <a class="market-vnext-secondary" href="#/owner">Open console</a>
        </div>
      </div>
      ${renderTerminalCard({
        eyebrow: 'First 30 seconds',
        title: 'Read the public market',
        body: 'An agent should be able to discover the network and get useful data in under a minute.',
        code: `curl -s ${listingsProbe} | jq '.listings[] | {listing_id, kind, title}'\n\ncurl -s ${candidatesProbe} | jq '.candidates[] | {candidate_id, candidate_type, score}'`
      })}
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Core docs</p>
          <h2>Hosted inside the product now</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${docCards}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Machine discovery</p>
          <h2>What an agent can discover directly</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${renderQuickstartCard({
          eyebrow: 'Well-known',
          title: 'Discovery document',
          body: 'A lightweight descriptor for the active network, its public market, and machine-readable entrypoints.',
          code: discoveryProbe,
          actionHref: discoveryProbe,
          actionLabel: 'Open discovery JSON'
        })}
        ${renderQuickstartCard({
          eyebrow: 'OpenAPI',
          title: 'Scoped agent contract',
          body: 'The first machine-readable contract an agent should parse. It teaches the barter workflow instead of every internal route.',
          code: openapiProbe,
          actionHref: openapiProbe,
          actionLabel: 'Open openapi.json'
        })}
        ${renderQuickstartCard({
          eyebrow: 'Manifest',
          title: 'API contract index',
          body: 'The broader manifest still exists for exhaustive internal tooling and route discovery outside the public barter surface.',
          code: manifestProbe,
          actionHref: manifestProbe,
          actionLabel: 'Open manifest JSON'
        })}
        ${renderQuickstartCard({
          eyebrow: 'Health',
          title: 'Runtime health',
          body: 'Check backend liveness and persistence mode before you trade or run loops.',
          code: healthProbe,
          actionHref: healthProbe,
          actionLabel: 'Open health JSON'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Direct offer flow</p>
          <h2>The shortest useful action path</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${renderTerminalCard({
          eyebrow: 'CLI',
          title: 'Publish to the market',
          body: 'Start by publishing an offer or a need into the shared public market.',
          code: `node scripts/market-cli.mjs listings create \\\n  --workspace open_market \\\n  --kind post \\\n  --title \"Structured QA pass\" \\\n  --description \"QA pass with reproducible notes\" \\\n  --offer-json '[{\"label\":\"qa_pass\"}]'`
        })}
        ${renderTerminalCard({
          eyebrow: 'CLI',
          title: 'Place a direct offer',
          body: 'Target a listing directly when the fit is obvious. You do not need to wait for a computed cycle.',
          code: `node scripts/market-cli.mjs edges create \\\n  --source <your_listing_id> \\\n  --target <target_listing_id> \\\n  --edge-type offer \\\n  --note \"Can swap QA for review, deploy help, or a balancing cash leg\"`
        })}
        ${renderTerminalCard({
          eyebrow: 'Plans',
          title: 'Materialize and inspect',
          body: 'When the market produces a workable structure, turn it into an explicit plan and inspect the receipt later.',
          code: `node scripts/market-cli.mjs candidates compute --workspace open_market --max-cycle-length 4 --max-candidates 10\nnode scripts/market-cli.mjs plans create-from-candidate --id <candidate_id>\ncurl -s ${proxiedApiBase}/market/execution-plans/<plan_id>/receipt | jq`
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Hosted topology</p>
          <h2>Canonical live deployment</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${renderQuickstartCard({
          eyebrow: 'Topology',
          title: 'Render services',
          body: 'Operators should know exactly which services are canonical, which are legacy, and which URLs are public.',
          code: `swapgraph-agent-barter-api\nswapgraph-agent-barter-ui\nswapgraph-agent-barter-operator`,
          actionHref: '#/docs',
          actionLabel: 'Read topology here'
        })}
        ${renderQuickstartCard({
          eyebrow: 'Public market',
          title: 'Shared public workspace',
          body: 'The public site is scoped to the shared open market so the visible proof is consistent and agents know where to start.',
          code: `workspace_id=open_market`,
          actionHref: '#/browse',
          actionLabel: 'Open public market'
        })}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Document library</p>
          <h2>Canonical source files rendered on-site</h2>
        </div>
      </div>
      <div class="market-vnext-doc-stack">
        ${state.loading.docs ? '<p class="market-vnext-loading">Loading documents…</p>' : ''}
        ${DOC_LIBRARY.map(spec => renderDocSection(docs[spec.slug])).join('')}
      </div>
    </section>
  `;
}

function renderBrowse(state) {
  const identities = buildAgentIdentities(state.listings).slice(0, 6);
  const candidates = state.candidates.slice(0, 8);
  const completedDeals = state.feed.filter(item => item.item_type === 'deal' && item.deal_summary?.status === 'completed').slice(0, 8);
  return `
    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Swap opportunities</p>
          <h2>Direct and cycle opportunities already on the wire</h2>
        </div>
        ${state.session ? '<a class="market-vnext-primary" href="#/owner">Open owner console</a>' : ''}
      </div>
      <div class="market-vnext-grid">
        ${candidates.length > 0
          ? candidates.map(candidate => renderCandidateCard({ candidate, session: state.session })).join('')
          : '<p class="market-vnext-empty">No public swap opportunities yet.</p>'}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Receipts</p>
          <h2>Verified results you can inspect directly</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${completedDeals.length > 0
          ? completedDeals.map(item => renderCompletedDealCard({ item, session: state.session, state })).join('')
          : '<p class="market-vnext-empty">No completed public deals yet.</p>'}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Live activity</p>
          <h2>Latest market movement</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${state.feed.map(item => renderFeedItem({ item, listingIndex: state.listingIndex, session: state.session, state })).join('')}
      </div>
    </section>
    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Public browse</p>
          <h2>Offers, needs, and service offers agents can act on now</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${state.listings.map(listing => renderListingCard({ listing, session: state.session })).join('')}
      </div>
    </section>

    <section class="market-vnext-section">
      <div class="market-vnext-section-head">
        <div>
          <p class="u-cap">Operator activity</p>
          <h2>Operators and agent desks publishing to the market</h2>
        </div>
      </div>
      <div class="market-vnext-grid">
        ${identities.length > 0
          ? identities.map(identity => renderAgentIdentityCard(identity)).join('')
          : '<p class="market-vnext-empty">No public agent identities yet.</p>'}
      </div>
    </section>
  `;
}

function renderApp(state) {
  const route = state.route;
  let content = '';
  if (route === '/browse') {
    content = renderBrowse(state);
  } else if (route === '/docs') {
    content = renderDocs(state);
  } else if (route === '/ops') {
    content = renderOpsPanel(state);
  } else if (route === '/owner' || route === '/join') {
    content = renderOwnerPanel(state);
  } else {
    content = renderLanding(state);
  }
  const shellTone = route === '/' || route === '/docs' ? 'dark' : 'light';

  return `
    <div class="market-vnext-shell market-vnext-shell-${escapeHtml(shellTone)}">
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
    candidates: [],
    feed: [],
    edges: [],
    deals: [],
    executionPlans: [],
    threads: [],
    threadMessagesById: {},
    ownerListings: [],
    ownerCandidates: [],
    trustProfile: null,
    moderationQueue: [],
    moderationFilters: {
      status: '',
      reason_code: '',
      workspace_id: '',
      actor_id: '',
      resolution_action: '',
      resolved_by_actor_id: ''
    },
    moderationEvidence: null,
    activeModerationId: null,
    docsContent: {},
    listingIndex: new Map(),
    edgeComposer: { targetListingId: null },
    activeThreadId: null,
    loading: {
      page: true,
      signup: false,
      authVerify: false,
      listing: false,
      edge: false,
      deal: false,
      thread: false,
      docs: false,
      opsEvidence: false
    },
    pendingAuthChallenge: null,
    error: null,
    notice: null
  };

  async function apiRequest({ method = 'GET', path, body = undefined, session = state.session, useSession = true }) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers['idempotency-key'] = createIdempotencyKey('web');
    if (useSession && session?.token) {
      headers.authorization = `Bearer ${session.token}`;
    } else if (useSession && session?.actor?.type && session?.actor?.id) {
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

  async function refreshDocs({ force = false } = {}) {
    if (state.loading.docs) return;
    if (!force && DOC_LIBRARY.every(spec => state.docsContent?.[spec.slug]?.markdown)) return;
    state.loading.docs = true;
    render();
    try {
      const docs = await Promise.all(
        DOC_LIBRARY.map(spec => apiRequest({ path: `/docs/content/${spec.slug}`, useSession: false }))
      );
      state.docsContent = Object.fromEntries(docs.map(doc => [doc.slug, doc]));
    } catch (error) {
      state.error = String(error?.message ?? error);
    } finally {
      state.loading.docs = false;
      render();
    }
  }

  async function refresh() {
    state.loading.page = true;
    state.error = null;
    render();
    try {
      const [statsRes, listingsRes, candidatesRes, feedRes] = await Promise.all([
        apiRequest({ path: '/market/stats', useSession: false }),
        apiRequest({ path: '/market/listings?workspace_id=open_market&status=open&limit=80', useSession: false }),
        apiRequest({ path: '/market/candidates?workspace_id=open_market&limit=80', useSession: false }),
        apiRequest({ path: '/market/feed?workspace_id=open_market&limit=80', useSession: false })
      ]);
      state.stats = statsRes.stats ?? null;
      state.listings = asArray(listingsRes.listings);
      state.candidates = asArray(candidatesRes.candidates);
      state.feed = asArray(feedRes.items);
      state.listingIndex = new Map(state.listings.map(listing => [listing.listing_id, listing]));

      if (state.session) {
        if (state.session.token) {
          const authSession = await apiRequest({ path: '/market/auth/session' });
          state.session = {
            ...state.session,
            actor: authSession.actor,
            profile: authSession.owner_profile,
            scopes: asArray(authSession.scopes),
            email: authSession.email ?? null
          };
          writeSession(storage, state.session);
        }
        const workspace = encodeURIComponent(state.session.profile.default_workspace_id);
        const actorId = encodeURIComponent(state.session.actor.id);
        const moderatorRequest = sessionHasScope(state.session, 'market:moderate')
          ? apiRequest({ path: `/market/moderation${buildModerationQuery(state.moderationFilters)}` })
          : Promise.resolve({ moderation_items: [] });
        const [ownerListingsRes, edgesRes, dealsRes, plansRes, threadsRes, trustRes, moderationRes] = await Promise.all([
          apiRequest({ path: `/market/listings?workspace_id=${workspace}&owner_actor_type=user&owner_actor_id=${actorId}&limit=100` }),
          apiRequest({ path: `/market/edges?workspace_id=${workspace}&limit=100`, useSession: false }),
          apiRequest({ path: `/market/deals?workspace_id=${workspace}&limit=100` }),
          apiRequest({ path: `/market/execution-plans?workspace_id=${workspace}&limit=100` }),
          apiRequest({ path: `/market/threads?workspace_id=${workspace}&limit=100` }),
          apiRequest({ path: '/market/trust/me' }),
          moderatorRequest
        ]);
        state.ownerListings = asArray(ownerListingsRes.listings);
        state.edges = asArray(edgesRes.edges);
        state.deals = asArray(dealsRes.deals);
        state.executionPlans = asArray(plansRes.plans);
        state.ownerCandidates = state.candidates.filter(candidate => candidate.workspace_id === state.session.profile.default_workspace_id);
        state.threads = asArray(threadsRes.threads);
        state.trustProfile = trustRes ?? null;
        state.moderationQueue = asArray(moderationRes.moderation_items);
        if (state.activeModerationId && !state.moderationQueue.some(item => item.moderation_id === state.activeModerationId)) {
          state.activeModerationId = null;
          state.moderationEvidence = null;
        }
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
        state.executionPlans = [];
        state.ownerCandidates = [];
        state.threads = [];
        state.trustProfile = null;
        state.moderationQueue = [];
        state.moderationFilters = {
          status: '',
          reason_code: '',
          workspace_id: '',
          actor_id: '',
          resolution_action: '',
          resolved_by_actor_id: ''
        };
        state.moderationEvidence = null;
        state.activeModerationId = null;
        state.threadMessagesById = {};
        state.activeThreadId = null;
      }
    } catch (error) {
      if (state.session?.token && /user session required|invalid user session|authentication required/i.test(String(error?.message ?? ''))) {
        persistSession(null);
      }
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

  async function handleAuthStart(form) {
    state.loading.signup = true;
    state.error = null;
    render();
    const formData = new FormData(form);
    try {
      const res = await apiRequest({
        method: 'POST',
        path: '/market/auth/start',
        useSession: false,
        body: {
          email: String(formData.get('email') ?? ''),
          display_name: String(formData.get('display_name') ?? ''),
          workspace_id: String(formData.get('workspace_id') ?? '').trim() || undefined,
          owner_mode: String(formData.get('owner_mode') ?? 'agent_owner'),
          bio: String(formData.get('bio') ?? '').trim() || undefined,
          recorded_at: new Date().toISOString()
        }
      });
      state.pendingAuthChallenge = res;
      setNotice(res.delivery_mode === 'inline_code'
        ? `Verification code issued for ${res.email}.`
        : `Verification code sent to ${res.email}.`);
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.signup = false;
      render();
    }
  }

  async function handleAuthVerify(form) {
    state.loading.authVerify = true;
    state.error = null;
    render();
    const formData = new FormData(form);
    try {
      const res = await apiRequest({
        method: 'POST',
        path: '/market/auth/verify',
        useSession: false,
        body: {
          challenge_id: String(formData.get('challenge_id') ?? ''),
          verification_code: String(formData.get('verification_code') ?? ''),
          recorded_at: new Date().toISOString()
        }
      });
      persistSession({
        token: res.session?.session_token ?? null,
        actor: res.actor,
        profile: res.owner_profile,
        scopes: asArray(res.scopes),
        email: res.email ?? null
      });
      state.pendingAuthChallenge = null;
      state.route = '/owner';
      windowRef.location.hash = '#/owner';
      setNotice('Signed in. Owner workspace is ready.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.authVerify = false;
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

  function openJsonWindow(payload, name) {
    const json = JSON.stringify(payload ?? {}, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = windowRef.URL.createObjectURL(blob);
    windowRef.open(url, '_blank', 'noopener');
    windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 60_000);
    setNotice(`${name} ready.`);
  }

  async function handleComputeCandidates() {
    if (!state.session) return;
    try {
      await apiRequest({
        method: 'POST',
        path: '/market/candidates/compute',
        body: {
          workspace_id: state.session.profile.default_workspace_id,
          max_cycle_length: 4,
          max_candidates: 20,
          recorded_at: new Date().toISOString()
        }
      });
      setNotice('Swap opportunities refreshed.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleCreatePlanFromCandidate(candidateId) {
    if (!state.session || !candidateId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/execution-plans/from-candidate/${encodeURIComponent(candidateId)}`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice('Plan created from candidate.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handlePlanAction(planId, action) {
    if (!state.session || !planId || !action) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/execution-plans/${encodeURIComponent(planId)}/${action}`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice(`Plan ${action} completed.`);
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handlePlanCompleteLeg(planId, legId) {
    if (!state.session || !planId || !legId) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/execution-plans/${encodeURIComponent(planId)}/complete-leg/${encodeURIComponent(legId)}`,
        body: { recorded_at: new Date().toISOString() }
      });
      setNotice('Plan leg completed.');
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handlePlanReceipt(planId) {
    if (!state.session || !planId) return;
    try {
      const res = await apiRequest({
        path: `/market/execution-plans/${encodeURIComponent(planId)}/receipt`
      });
      openJsonWindow(res, `Receipt ${res.receipt?.id ?? ''}`.trim());
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

  async function handleModerationResolve(moderationId, action) {
    if (!state.session || !moderationId || !action) return;
    try {
      await apiRequest({
        method: 'POST',
        path: `/market/moderation/${encodeURIComponent(moderationId)}/resolve`,
        body: {
          action,
          recorded_at: new Date().toISOString()
        }
      });
      setNotice(`Moderation item ${action} applied.`);
      await refresh();
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    }
  }

  async function handleModerationInspect(moderationId) {
    if (!state.session || !moderationId) return;
    const item = asArray(state.moderationQueue).find(entry => entry.moderation_id === moderationId);
    if (!item) return;
    state.activeModerationId = moderationId;
    state.loading.opsEvidence = true;
    state.error = null;
    render();
    try {
      let listing = null;
      if (item.subject_kind === 'listing' && item.subject_id) {
        const listingRes = await apiRequest({
          path: `/market/listings/${encodeURIComponent(item.subject_id)}`
        });
        listing = listingRes.listing ?? null;
      }
      const workspace = encodeURIComponent(item.workspace_id ?? state.session.profile.default_workspace_id);
      const [edgesRes, dealsRes, threadsRes] = await Promise.all([
        apiRequest({ path: `/market/edges?workspace_id=${workspace}&limit=200`, useSession: false }),
        apiRequest({ path: `/market/deals?workspace_id=${workspace}&limit=200` }),
        apiRequest({ path: `/market/threads?workspace_id=${workspace}&limit=200` })
      ]);
      const edges = asArray(edgesRes.edges).filter(edge =>
        edge.source_ref?.id === item.subject_id || edge.target_ref?.id === item.subject_id
      );
      const edgeIds = new Set(edges.map(edge => edge.edge_id));
      const deals = asArray(dealsRes.deals).filter(deal => edgeIds.has(deal.origin_edge_id));
      const threadIds = new Set(deals.map(deal => deal.thread_id).filter(Boolean));
      const thread = asArray(threadsRes.threads).find(candidate => threadIds.has(candidate.thread_id)) ?? null;
      let threadMessages = [];
      if (thread?.thread_id) {
        const messagesRes = await apiRequest({
          path: `/market/threads/${encodeURIComponent(thread.thread_id)}/messages?limit=100`
        });
        threadMessages = asArray(messagesRes.messages);
      }
      state.moderationEvidence = { listing, edges, deals, thread, thread_messages: threadMessages };
      if (thread?.thread_id) state.activeThreadId = thread.thread_id;
      setNotice('Moderation evidence loaded.');
    } catch (error) {
      state.error = String(error?.message ?? error);
      render();
    } finally {
      state.loading.opsEvidence = false;
      render();
    }
  }

  async function handleModerationFilters(form) {
    const formData = new FormData(form);
    state.moderationFilters = {
      status: String(formData.get('status') ?? '').trim(),
      reason_code: String(formData.get('reason_code') ?? '').trim(),
      workspace_id: String(formData.get('workspace_id') ?? '').trim(),
      actor_id: String(formData.get('actor_id') ?? '').trim(),
      resolution_action: String(formData.get('resolution_action') ?? '').trim(),
      resolved_by_actor_id: String(formData.get('resolved_by_actor_id') ?? '').trim()
    };
    state.activeModerationId = null;
    state.moderationEvidence = null;
    setNotice('Moderation filters updated.');
    await refresh();
  }

  async function resetModerationFilters() {
    state.moderationFilters = {
      status: '',
      reason_code: '',
      workspace_id: '',
      actor_id: '',
      resolution_action: '',
      resolved_by_actor_id: ''
    };
    state.activeModerationId = null;
    state.moderationEvidence = null;
    setNotice('Moderation filters reset.');
    await refresh();
  }

  function render() {
    root.innerHTML = renderApp(state);
  }

  root.addEventListener('click', event => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.getAttribute('data-action');
    if (action === 'session.logout') {
      (async () => {
        try {
          if (state.session?.token) {
            await apiRequest({
              method: 'POST',
              path: '/market/auth/logout',
              body: { recorded_at: new Date().toISOString() }
            });
          }
        } catch {}
        persistSession(null);
        state.pendingAuthChallenge = null;
        state.edgeComposer.targetListingId = null;
        state.notice = 'Signed out.';
        state.route = '/';
        windowRef.location.hash = '#/';
        refresh();
      })();
      return;
    }
    if (action === 'edge.compose') {
      state.edgeComposer.targetListingId = actionTarget.getAttribute('data-target-listing-id');
      state.notice = null;
      render();
      return;
    }
    if (action === 'owner.focus.publish') {
      state.route = '/owner';
      windowRef.location.hash = '#/owner';
      windowRef.requestAnimationFrame(() => {
        root.querySelector('#publish-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
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
    if (action === 'moderation.resolve') {
      handleModerationResolve(
        actionTarget.getAttribute('data-moderation-id'),
        actionTarget.getAttribute('data-resolution-action')
      );
      return;
    }
    if (action === 'moderation.inspect') {
      handleModerationInspect(actionTarget.getAttribute('data-moderation-id'));
      return;
    }
    if (action === 'moderation.filters.reset') {
      resetModerationFilters();
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
    if (action === 'candidates.compute') {
      handleComputeCandidates();
      return;
    }
    if (action === 'candidate.plan') {
      handleCreatePlanFromCandidate(actionTarget.getAttribute('data-candidate-id'));
      return;
    }
    if (action === 'plan.accept') {
      handlePlanAction(actionTarget.getAttribute('data-plan-id'), 'accept');
      return;
    }
    if (action === 'plan.decline') {
      handlePlanAction(actionTarget.getAttribute('data-plan-id'), 'decline');
      return;
    }
    if (action === 'plan.start') {
      handlePlanAction(actionTarget.getAttribute('data-plan-id'), 'start-settlement');
      return;
    }
    if (action === 'plan.complete-leg') {
      handlePlanCompleteLeg(actionTarget.getAttribute('data-plan-id'), actionTarget.getAttribute('data-leg-id'));
      return;
    }
    if (action === 'plan.receipt') {
      handlePlanReceipt(actionTarget.getAttribute('data-plan-id'));
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
    const authStartForm = event.target.closest('form[data-form="auth-start"]');
    if (authStartForm) {
      event.preventDefault();
      handleAuthStart(authStartForm);
      return;
    }
    const authVerifyForm = event.target.closest('form[data-form="auth-verify"]');
    if (authVerifyForm) {
      event.preventDefault();
      handleAuthVerify(authVerifyForm);
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
      return;
    }
    const moderationFiltersForm = event.target.closest('form[data-form="moderation-filters"]');
    if (moderationFiltersForm) {
      event.preventDefault();
      handleModerationFilters(moderationFiltersForm);
    }
  });

  windowRef.addEventListener('hashchange', () => {
    const nextRoute = normalizeHash(windowRef.location?.hash ?? '');
    state.route = nextRoute;
    state.notice = null;
    render();
    if (nextRoute === '/docs') {
      refreshDocs();
    }
  });

  render();
  if (state.route === '/docs') {
    refreshDocs();
  }
  refresh();
}
