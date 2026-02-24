export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatIsoShort(isoString) {
  if (!isoString) return 'n/a';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function toneFromState(state) {
  if (state === 'completed') return 'signal';
  if (state === 'failed') return 'danger';
  if (state === 'escrow.pending' || state === 'executing') return 'caution';
  return 'neutral';
}

export function formatUsd(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'n/a';
  return numeric.toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: numeric >= 1000 ? 0 : 2
  });
}
