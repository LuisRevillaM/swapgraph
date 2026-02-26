#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isNotificationChannelEnabled,
  isWithinQuietHours,
  normalizeNotificationPrefs,
  quietHoursLabel
} from '../../client/marketplace/src/features/notifications/preferences.mjs';
import { renderTabScreen } from '../../client/marketplace/src/ui/screens.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m6/sc-ux-07-settings-usability-report.json');

function baseState() {
  return {
    network: { online: true },
    route: { tab: 'items', params: {} },
    ui: {
      itemsSort: 'highest_demand',
      composer: { isOpen: false, mode: 'create', draft: null, errors: {}, submitting: false },
      notificationPrefs: {
        isOpen: false,
        values: {
          channels: { proposal: true, active: true, receipt: true },
          quietHours: { enabled: true, startHour: 22, endHour: 7 }
        }
      },
      intentMutations: {},
      proposalMutations: {},
      activeMutations: {}
    },
    caches: {
      inventoryAwakening: {
        value: {
          swappabilitySummary: {
            intentsTotal: 3,
            activeIntents: 2,
            cycleOpportunities: 5,
            averageConfidenceBps: 9100
          }
        }
      },
      intents: { items: [{ id: 'intent_1', offer: [{ assetId: 'asset_a', valueUsd: 100 }] }] },
      proposals: { items: [] },
      health: { value: null },
      matchingRuns: {},
      timeline: {},
      receipts: {}
    }
  };
}

function main() {
  const normalized = normalizeNotificationPrefs({
    channels: { proposal: false, active: true, receipt: 'invalid' },
    quietHours: { enabled: true, startHour: 25, endHour: -2 }
  });

  const lateNight = new Date();
  lateNight.setHours(23, 0, 0, 0);

  const itemsHtml = renderTabScreen(baseState());
  const overlayState = baseState();
  overlayState.ui.notificationPrefs.isOpen = true;
  const overlayHtml = renderTabScreen(overlayState);

  const checklist = [
    {
      id: 'preference_normalization_applies_defaults',
      pass: normalized.channels.proposal === false
        && normalized.channels.active === true
        && normalized.channels.receipt === true
        && normalized.quietHours.startHour === 22
        && normalized.quietHours.endHour === 7
    },
    {
      id: 'channel_toggles_respected',
      pass: isNotificationChannelEnabled(normalized, 'proposal') === false
        && isNotificationChannelEnabled(normalized, 'active') === true
    },
    {
      id: 'quiet_hours_window_and_label',
      pass: isWithinQuietHours(normalized, lateNight.getTime()) === true
        && /22:00-07:00/.test(quietHoursLabel(normalized))
    },
    {
      id: 'settings_summary_visible_from_items',
      pass: /Notification controls/.test(itemsHtml)
        && /quiet hours/i.test(itemsHtml)
        && /data-action=\"notifications.openPrefs\"/.test(itemsHtml)
    },
    {
      id: 'settings_overlay_controls_present',
      pass: /Notification preferences/.test(overlayHtml)
        && /data-form=\"notification-preferences\"/.test(overlayHtml)
        && /channel_proposal/.test(overlayHtml)
        && /quiet_start_hour/.test(overlayHtml)
        && /data-action=\"notifications.closePrefs\"/.test(overlayHtml)
    }
  ];

  const output = {
    check_id: 'SC-UX-07',
    generated_at: new Date().toISOString(),
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
