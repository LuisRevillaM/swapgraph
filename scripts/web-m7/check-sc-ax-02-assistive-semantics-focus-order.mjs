#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const shellPath = path.join(repoRoot, 'client/marketplace/src/ui/shell.mjs');
const tabsPath = path.join(repoRoot, 'client/marketplace/src/features/accessibility/tabs.mjs');
const outPath = path.join(repoRoot, 'artifacts/web-m7/sc-ax-02-assistive-semantics-focus-order-report.json');

function baseState(tab = 'items') {
  return {
    network: { online: true },
    route: { tab, params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      notificationPrefs: {
        isOpen: false,
        values: {
          channels: { proposal: true, active: true, receipt: true },
          quietHours: { enabled: false, startHour: 22, endHour: 7 }
        }
      },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      health: { value: null, updatedAt: 0 },
      inventoryAwakening: { value: null, updatedAt: 0 },
      intents: { items: [], updatedAt: 0 },
      proposals: { items: [], updatedAt: 0 },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

function main() {
  const shellSource = readFileSync(shellPath, 'utf8');
  const tabsSource = readFileSync(tabsPath, 'utf8');
  const tabs = ['items', 'intents', 'inbox', 'active', 'receipts'];
  const tabPanels = tabs.map(tab => renderTabScreen(baseState(tab)));

  const composerState = baseState('intents');
  composerState.ui.composer.isOpen = true;
  composerState.ui.composer.draft = {};
  const composerHtml = renderTabScreen(composerState);

  const prefsState = baseState('items');
  prefsState.ui.notificationPrefs.isOpen = true;
  const prefsHtml = renderTabScreen(prefsState);

  const focusOrderIndexes = {
    skip_link: shellSource.indexOf('class="skip-link'),
    topbar: shellSource.indexOf('class="topbar'),
    main: shellSource.indexOf('id="main-content"'),
    tabbar: shellSource.indexOf('id="tabbar"')
  };

  const checklist = [
    {
      id: 'shell_has_skip_link',
      pass: /class="skip-link/.test(shellSource)
    },
    {
      id: 'tablist_and_tabs_have_aria_semantics',
      pass: /role="tablist"/.test(shellSource)
        && /role="tab"/.test(shellSource)
        && /aria-controls=/.test(shellSource)
        && /aria-selected=/.test(shellSource)
    },
    {
      id: 'keyboard_navigation_support_present',
      pass: /keyboardNextTab/.test(shellSource)
        && /ArrowRight/.test(tabsSource)
        && /ArrowLeft/.test(tabsSource)
        && /Home/.test(tabsSource)
        && /End/.test(tabsSource)
    },
    {
      id: 'focus_order_skip_to_main_to_tabbar',
      pass: focusOrderIndexes.skip_link >= 0
        && focusOrderIndexes.topbar > focusOrderIndexes.skip_link
        && focusOrderIndexes.main > focusOrderIndexes.topbar
        && focusOrderIndexes.tabbar > focusOrderIndexes.main
    },
    {
      id: 'tabpanel_semantics_present_for_all_tabs',
      pass: tabPanels.every(html => /role="tabpanel"/.test(html) && /aria-labelledby=/.test(html))
    },
    {
      id: 'composer_dialog_is_modal',
      pass: /role="dialog"/.test(composerHtml)
        && /aria-modal="true"/.test(composerHtml)
        && /data-action="composer.close"/.test(composerHtml)
    },
    {
      id: 'notification_dialog_is_modal',
      pass: /role="dialog"/.test(prefsHtml)
        && /aria-modal="true"/.test(prefsHtml)
        && /data-action="notifications.closePrefs"/.test(prefsHtml)
    },
    {
      id: 'scrims_are_buttons_for_keyboard_escape_routes',
      pass: /button type="button" class="composer-scrim"/.test(composerHtml)
        && /button type="button" class="composer-scrim"/.test(prefsHtml)
    }
  ];

  const output = {
    check_id: 'SC-AX-02',
    generated_at: new Date().toISOString(),
    focus_order_indexes: focusOrderIndexes,
    checklist,
    pass: checklist.every(row => row.pass)
  };

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n', 'utf8');

  if (!output.pass) {
    process.stderr.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main();
