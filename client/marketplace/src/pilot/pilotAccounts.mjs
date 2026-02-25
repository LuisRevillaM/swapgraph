function normalizeToken(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function itemImageUri({ name, emoji, start, end }) {
  const title = String(name ?? '').slice(0, 28);
  const gradientA = String(start ?? '#1a7a4c');
  const gradientB = String(end ?? '#355c7d');
  const icon = String(emoji ?? '🎮');
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${escapeXml(gradientA)}"/>
      <stop offset="100%" stop-color="${escapeXml(gradientB)}"/>
    </linearGradient>
  </defs>
  <rect width="400" height="400" rx="40" fill="url(#g)"/>
  <circle cx="86" cy="84" r="56" fill="rgba(255,255,255,0.18)"/>
  <text x="86" y="100" text-anchor="middle" font-size="58">${escapeXml(icon)}</text>
  <text x="26" y="334" font-family="DM Sans,Arial,sans-serif" font-size="28" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
</svg>
  `.trim();

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function decorateInventoryItem(item) {
  return Object.freeze({
    assetId: item.assetId,
    name: item.name,
    blurb: item.blurb,
    imageUrl: itemImageUri(item)
  });
}

const ACCOUNT_FIXTURES = [
  {
    actorId: 'u1',
    name: 'Javier',
    tagline: 'Ship fast, roast bugs, stack fake alpha.',
    inventory: [
      { assetId: 'javier_prompt_lambo', name: 'Prompt Lambo Pass', blurb: 'Unlocks spicy one-liners in standup.', emoji: '🏎️', start: '#1a7a4c', end: '#124f33' },
      { assetId: 'javier_ci_saber', name: 'CI Lightsaber', blurb: 'Cuts flaky tests before breakfast.', emoji: '🧪', start: '#355c7d', end: '#1e3b57' },
      { assetId: 'javier_meme_coin', name: 'Meme Yield Badge', blurb: 'Boosts confidence by 9,000 bps.', emoji: '💸', start: '#b07b1a', end: '#7f4f00' }
    ]
  },
  {
    actorId: 'u2',
    name: 'Jesus',
    tagline: 'Agent wrangler with elite caffeine uptime.',
    inventory: [
      { assetId: 'jesus_agent_hawk', name: 'Agent Hawk Token', blurb: 'Autopilot with tasteful chaos.', emoji: '🦅', start: '#214e8a', end: '#132f52' },
      { assetId: 'jesus_deploy_hoodie', name: 'Deploy Hoodie', blurb: 'Warms hands during prod pushes.', emoji: '🧥', start: '#0f8a5f', end: '#0a5a3e' },
      { assetId: 'jesus_bug_filter', name: 'Bug Filter Lens', blurb: 'Shows root causes in under 60 seconds.', emoji: '🔍', start: '#7b5ea7', end: '#4b3b6b' }
    ]
  },
  {
    actorId: 'u3',
    name: 'Edgar',
    tagline: 'Latency assassin, UX comedian.',
    inventory: [
      { assetId: 'edgar_latency_charm', name: 'Latency Charm', blurb: 'Turns 500ms into 90ms vibes.', emoji: '⚡', start: '#f29f05', end: '#b36a00' },
      { assetId: 'edgar_refactor_scroll', name: 'Refactor Scroll', blurb: 'One scroll, six dead TODOs.', emoji: '📜', start: '#3f7d20', end: '#234b12' },
      { assetId: 'edgar_chaos_shield', name: 'Chaos Shield', blurb: 'Protects demos from random gremlins.', emoji: '🛡️', start: '#4f6d7a', end: '#2d434d' }
    ]
  },
  {
    actorId: 'u4',
    name: 'Gabo',
    tagline: 'Design pirate with ruthless merge discipline.',
    inventory: [
      { assetId: 'gabo_pixel_compass', name: 'Pixel Compass', blurb: 'Keeps every screen on-brand.', emoji: '🧭', start: '#8a5b0f', end: '#593708' },
      { assetId: 'gabo_commit_crown', name: 'Commit Crown', blurb: 'Grants +3 morale to every PR.', emoji: '👑', start: '#b07b1a', end: '#7f4f00' },
      { assetId: 'gabo_vibe_turbine', name: 'Vibe Turbine', blurb: 'Converts ideas into launch copy.', emoji: '🌀', start: '#1a7a4c', end: '#0f4d31' }
    ]
  },
  {
    actorId: 'u5',
    name: 'Luis',
    tagline: 'Founder mode: strategy by day, shipper by night.',
    inventory: [
      { assetId: 'luis_roadmap_orb', name: 'Roadmap Orb', blurb: 'Spots market moves 3 weeks early.', emoji: '🔮', start: '#3f5773', end: '#243547' },
      { assetId: 'luis_growth_fork', name: 'Growth Fork', blurb: 'Splits one idea into three bets.', emoji: '🍴', start: '#8b3a3a', end: '#532323' },
      { assetId: 'luis_friend_pass', name: 'Friends Pilot Pass', blurb: 'Lets the whole squad join the game.', emoji: '🎟️', start: '#1a7a4c', end: '#124f33' }
    ]
  }
];

export const PILOT_ACCOUNTS = Object.freeze(
  ACCOUNT_FIXTURES.map(account => Object.freeze({
    actorId: account.actorId,
    name: account.name,
    tagline: account.tagline,
    inventory: Object.freeze(account.inventory.map(decorateInventoryItem))
  }))
);

const ACCOUNT_BY_ACTOR_ID = new Map(PILOT_ACCOUNTS.map(account => [account.actorId, account]));
const ACCOUNT_BY_NAME = new Map(
  PILOT_ACCOUNTS.flatMap(account => [
    [normalizeToken(account.name), account],
    [normalizeToken(account.actorId), account]
  ])
);

export function pilotAccountByActorId(actorId) {
  const normalized = String(actorId ?? '').trim();
  if (!normalized) return null;
  return ACCOUNT_BY_ACTOR_ID.get(normalized) ?? null;
}

export function isPilotActorId(actorId) {
  return Boolean(pilotAccountByActorId(actorId));
}

export function resolvePilotAccountByName(rawName) {
  const normalized = normalizeToken(rawName);
  if (!normalized) return null;
  return ACCOUNT_BY_NAME.get(normalized) ?? null;
}

