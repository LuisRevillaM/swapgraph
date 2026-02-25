import { safeStorageRead, safeStorageWrite, sanitizeActorId } from '../features/security/storagePolicy.mjs';
import { PILOT_ACCOUNTS, isPilotActorId, resolvePilotAccountByName } from '../pilot/pilotAccounts.mjs';
import { escapeHtml } from '../utils/format.mjs';
import { SESSION_ACTOR_STORAGE_KEY, actorIdFromLocationSearch } from './actorIdentity.mjs';

function clearStoredActorId(storage) {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_ACTOR_STORAGE_KEY);
  } catch {
    // ignore storage clear failures
  }
}

export function resolveActivePilotActorId({ storage = null, locationSearch = '' } = {}) {
  const fromQuery = actorIdFromLocationSearch(locationSearch);
  if (isPilotActorId(fromQuery)) {
    safeStorageWrite(storage, SESSION_ACTOR_STORAGE_KEY, fromQuery);
    return fromQuery;
  }

  const stored = sanitizeActorId(safeStorageRead(storage, SESSION_ACTOR_STORAGE_KEY));
  if (isPilotActorId(stored)) return stored;

  clearStoredActorId(storage);
  return null;
}

function loginPreviewCard(account) {
  const firstItem = account.inventory[0] ?? null;
  return `
    <article class="pilot-preview-card">
      <img
        src="${escapeHtml(firstItem?.imageUrl ?? '')}"
        alt="${escapeHtml(firstItem ? `${account.name} inventory preview` : `${account.name} preview`)}"
        loading="lazy"
      />
      <h3 class="u-text-base u-weight-600">${escapeHtml(account.name)}</h3>
      <p class="u-text-sm u-ink-3">${escapeHtml(account.tagline)}</p>
    </article>
  `;
}

export function mountPilotLogin({ root, storage = null, onSelected = null } = {}) {
  if (!root) throw new Error('root is required');

  root.innerHTML = `
    <main class="pilot-login" aria-label="Pilot account sign in">
      <section class="pilot-login-card">
        <p class="u-cap">Friends Pilot</p>
        <h1 class="u-display">Pick Your Account</h1>
        <p class="u-text-base u-ink-2">
          Type your name or use the dropdown. Each account has a funny 3-item starter locker.
        </p>

        <form class="pilot-login-form" data-form="pilot-login">
          <label class="pilot-login-label u-text-sm u-weight-600" for="pilot-account-select">Choose from dropdown</label>
          <select class="pilot-login-select" id="pilot-account-select" name="actor_id">
            <option value="">Select account</option>
            ${PILOT_ACCOUNTS.map(account => `
              <option value="${escapeHtml(account.actorId)}">${escapeHtml(account.name)}</option>
            `).join('')}
          </select>

          <label class="pilot-login-label u-text-sm u-weight-600" for="pilot-account-name">Or type your name</label>
          <input
            class="pilot-login-input"
            id="pilot-account-name"
            name="account_name"
            type="text"
            list="pilot-account-names"
            placeholder="Javier, Jesus, Edgar, Gabo, Luis"
            autocomplete="off"
          />
          <datalist id="pilot-account-names">
            ${PILOT_ACCOUNTS.map(account => `<option value="${escapeHtml(account.name)}"></option>`).join('')}
          </datalist>

          <p class="pilot-login-error u-text-sm" id="pilot-login-error" aria-live="polite"></p>

          <button type="submit" class="pilot-login-button u-text-base u-weight-600">Enter Marketplace</button>
        </form>

        <div class="pilot-preview-grid">
          ${PILOT_ACCOUNTS.map(loginPreviewCard).join('')}
        </div>
      </section>
    </main>
  `;

  const form = root.querySelector('[data-form="pilot-login"]');
  const select = root.querySelector('#pilot-account-select');
  const input = root.querySelector('#pilot-account-name');
  const errorNode = root.querySelector('#pilot-login-error');

  if (!form || !select || !input || !errorNode) return;

  form.addEventListener('submit', event => {
    event.preventDefault();

    const typedAccount = resolvePilotAccountByName(input.value);
    const selectedAccount = resolvePilotAccountByName(select.value);
    const account = typedAccount ?? selectedAccount ?? null;

    if (!account) {
      errorNode.textContent = 'Pick one of the 5 accounts to continue.';
      return;
    }

    safeStorageWrite(storage, SESSION_ACTOR_STORAGE_KEY, account.actorId);
    if (typeof onSelected === 'function') onSelected(account);
  });
}

