import { bootstrapMarketplaceClient } from './src/app/bootstrap.mjs';
import { disableServiceWorkerForRollback, serviceWorkerMode } from './src/app/serviceWorkerControl.mjs';
import { mountPilotLogin, resolveActivePilotActorId } from './src/session/pilotLogin.mjs';

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (serviceWorkerMode(window) === 'off') {
    await disableServiceWorkerForRollback(window);
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js');
  } catch {
    // service worker registration failures are non-fatal for app boot
  }
}

function mount() {
  const root = document.getElementById('app-root');
  if (!root) throw new Error('missing #app-root mount element');

  const activeActorId = resolveActivePilotActorId({
    storage: window?.localStorage ?? null,
    locationSearch: window?.location?.search ?? ''
  });

  if (!activeActorId) {
    mountPilotLogin({
      root,
      storage: window?.localStorage ?? null,
      onSelected: () => {
        window.location.reload();
      }
    });
    return;
  }

  bootstrapMarketplaceClient({ root });
  registerServiceWorker();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
