import { MARKETPLACE_TABS } from '../app/tabs.mjs';
import { keyboardNextTab, panelA11yId, tabA11yId } from '../features/accessibility/tabs.mjs';
import { escapeHtml } from '../utils/format.mjs';
import { renderTabScreen } from './screens.mjs';

function renderTabButtons(activeTab) {
  return MARKETPLACE_TABS.map(tab => {
    const isActive = tab.id === activeTab;
    return `
      <button
        type="button"
        class="tab-btn${isActive ? ' is-active' : ''}"
        data-tab-id="${tab.id}"
        role="tab"
        id="${tabA11yId(tab.id)}"
        aria-controls="${panelA11yId(tab.id)}"
        aria-selected="${isActive ? 'true' : 'false'}"
        aria-label="${tab.label}"
        aria-current="${isActive ? 'page' : 'false'}"
      >
        <span class="tab-icon" aria-hidden="true">${tab.icon}</span>
        <span class="tab-label u-text-sm">${tab.label}</span>
      </button>
    `;
  }).join('');
}

function renderBanner(banner) {
  if (!banner) return '';
  const tone = banner.tone ?? 'neutral';
  const title = banner.title ?? 'Status';
  const message = banner.message ?? '';
  return `
    <div class="status-banner tone-${escapeHtml(tone)}" role="status" aria-live="polite">
      <p class="u-text-sm u-weight-600">${escapeHtml(title)}</p>
      <p class="u-text-base">${escapeHtml(message)}</p>
    </div>
  `;
}

function renderErrorFallback(error) {
  if (!error) return '';
  return `
    <article class="card card-error" role="alert" aria-live="assertive">
      <h3 class="u-text-md u-weight-600">Read Surface Error</h3>
      <p class="u-text-base">${escapeHtml(error.message ?? 'Request failed')}</p>
      <p class="u-text-sm u-ink-3">Code: <span class="u-text-data">${escapeHtml(error.code ?? 'UNKNOWN')}</span></p>
    </article>
  `;
}

export function createMarketplaceShell({ root, onNavigate, onReload, onUiEvent = null, onSwitchAccount = null }) {
  if (!root) throw new Error('root element is required');
  if (typeof onNavigate !== 'function') throw new Error('onNavigate is required');

  root.innerHTML = `
    <a href="#main-content" class="skip-link u-text-sm">Skip to content</a>
    <div class="app-shell">
      <header class="topbar" aria-label="Marketplace top actions">
        <div class="brand-wrap">
          <span class="logo-mark" aria-hidden="true"></span>
          <div>
            <p class="u-cap">SwapGraph</p>
            <h1 class="brand-title u-text-md">Marketplace Client</h1>
          </div>
        </div>
        <div class="top-actions">
          <span class="live-pill u-text-sm" id="live-pill" title="System matching is active">Always matching</span>
          <button type="button" class="refresh-btn u-text-sm" id="btn-switch-account">Switch</button>
          <button type="button" class="refresh-btn u-text-sm" id="btn-open-notifications">Alerts</button>
          <button type="button" class="refresh-btn u-text-sm" id="btn-refresh-route">Refresh</button>
        </div>
      </header>

      <main class="main" id="main-content" tabindex="-1" aria-live="polite"></main>

      <nav class="tabbar" aria-label="Marketplace tabs" id="tabbar" role="tablist"></nav>
    </div>
  `;

  const main = root.querySelector('#main-content');
  const tabbar = root.querySelector('#tabbar');
  const refreshButton = root.querySelector('#btn-refresh-route');
  const switchAccountButton = root.querySelector('#btn-switch-account');
  const openNotificationsButton = root.querySelector('#btn-open-notifications');
  const livePill = root.querySelector('#live-pill');

  tabbar.addEventListener('click', event => {
    const button = event.target.closest('button[data-tab-id]');
    if (!button) return;
    const tabId = button.getAttribute('data-tab-id');
    if (!tabId) return;
    onNavigate({ tab: tabId, params: {} });
  });

  tabbar.addEventListener('keydown', event => {
    const key = String(event?.key ?? '');
    const activeButton = tabbar.querySelector('button[data-tab-id].is-active');
    const activeTab = activeButton?.getAttribute('data-tab-id') ?? 'items';
    const nextTab = keyboardNextTab({ activeTab, key });
    if (!nextTab) return;
    event.preventDefault();
    onNavigate({ tab: nextTab, params: {} });
    queueMicrotask(() => {
      tabbar.querySelector(`button[data-tab-id="${nextTab}"]`)?.focus();
    });
  });

  if (refreshButton && typeof onReload === 'function') {
    refreshButton.addEventListener('click', () => onReload());
  }

  if (switchAccountButton && typeof onSwitchAccount === 'function') {
    switchAccountButton.addEventListener('click', () => onSwitchAccount());
  }

  if (openNotificationsButton && typeof onUiEvent === 'function') {
    openNotificationsButton.addEventListener('click', () => {
      onUiEvent({ type: 'notifications.openPrefs' });
    });
  }

  main.addEventListener('click', event => {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget || typeof onUiEvent !== 'function') return;

    const action = actionTarget.getAttribute('data-action');
    if (!action) return;

    onUiEvent({
      type: action,
      intentId: actionTarget.getAttribute('data-intent-id') ?? null,
      proposalId: actionTarget.getAttribute('data-proposal-id') ?? null,
      receiptId: actionTarget.getAttribute('data-receipt-id') ?? null,
      cycleId: actionTarget.getAttribute('data-cycle-id') ?? null,
      actionKey: actionTarget.getAttribute('data-action-key') ?? null,
      sort: actionTarget.getAttribute('data-sort') ?? null,
      rank: actionTarget.getAttribute('data-rank') ?? null
    });
  });

  main.addEventListener('submit', event => {
    const form = event.target.closest('form[data-form="intent-composer"]');
    if (form && typeof onUiEvent === 'function') {
      event.preventDefault();
      const formData = new FormData(form);
      onUiEvent({
        type: 'composer.submit',
        fields: {
          mode: String(formData.get('mode') ?? 'create'),
          offering_asset_id: String(formData.get('offering_asset_id') ?? ''),
          offer_value_usd: String(formData.get('offer_value_usd') ?? ''),
          want_category: String(formData.get('want_category') ?? ''),
          acceptable_wear: formData.getAll('acceptable_wear').map(value => String(value)),
          value_tolerance_usd: String(formData.get('value_tolerance_usd') ?? ''),
          max_cycle_length: String(formData.get('max_cycle_length') ?? '')
        }
      });
      return;
    }

    const notificationForm = event.target.closest('form[data-form="notification-preferences"]');
    if (notificationForm && typeof onUiEvent === 'function') {
      event.preventDefault();
      const formData = new FormData(notificationForm);
      onUiEvent({
        type: 'notifications.savePrefs',
        fields: {
          channel_proposal: formData.get('channel_proposal') !== null,
          channel_active: formData.get('channel_active') !== null,
          channel_receipt: formData.get('channel_receipt') !== null,
          quiet_enabled: formData.get('quiet_enabled') !== null,
          quiet_start_hour: String(formData.get('quiet_start_hour') ?? ''),
          quiet_end_hour: String(formData.get('quiet_end_hour') ?? '')
        }
      });
    }
  });

  return {
    render(state) {
      const activeTab = state?.route?.tab ?? 'items';
      tabbar.innerHTML = renderTabButtons(activeTab);

      const isOnline = state?.network?.online !== false;
      if (livePill) {
        livePill.textContent = isOnline ? 'Always matching' : 'Offline cache mode';
        livePill.title = isOnline
          ? 'System matching is active'
          : 'Network unavailable, showing cached read surfaces when possible';
        livePill.classList.toggle('is-offline', !isOnline);
      }

      const loading = Boolean(state?.loadingByTab?.[activeTab]);
      const screenHtml = renderTabScreen(state);
      const errorHtml = renderErrorFallback(state?.errorByTab?.[activeTab]);
      const bannerHtml = renderBanner(state?.statusBanner);

      main.innerHTML = `
        ${bannerHtml}
        ${loading ? '<p class="loading-line u-text-sm">Loading latest read surface...</p>' : ''}
        ${errorHtml}
        ${screenHtml}
      `;
    }
  };
}
