#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { staleBannerCopy } from '../../client/marketplace/src/features/offline/cacheSnapshot.mjs';
import { normalizeNotificationPrefs, isWithinQuietHours } from '../../client/marketplace/src/features/notifications/preferences.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'artifacts/web-m6/sc-rl-03-stale-data-signaling-report.json');

function main() {
  const offlineHit = staleBannerCopy({
    tab: 'receipts',
    offline: true,
    hasCache: true,
    savedAtMs: Date.parse('2026-02-24T16:00:00.000Z')
  });

  const offlineMiss = staleBannerCopy({
    tab: 'active',
    offline: true,
    hasCache: false,
    savedAtMs: null
  });

  const onlineRefresh = staleBannerCopy({
    tab: 'inbox',
    offline: false,
    hasCache: true
  });

  const prefs = normalizeNotificationPrefs({
    channels: { proposal: true, active: true, receipt: true },
    quietHours: { enabled: true, startHour: 22, endHour: 7 }
  });
  const quietAt23Date = new Date();
  quietAt23Date.setHours(23, 0, 0, 0);
  const quietAt12Date = new Date();
  quietAt12Date.setHours(12, 0, 0, 0);
  const quietAt23 = isWithinQuietHours(prefs, quietAt23Date.getTime());
  const quietAt12 = isWithinQuietHours(prefs, quietAt12Date.getTime());

  const checklist = [
    {
      id: 'offline_hit_uses_caution_tone',
      pass: offlineHit.tone === 'caution' && /stale/i.test(offlineHit.message)
    },
    {
      id: 'offline_miss_discloses_no_cache',
      pass: offlineMiss.tone === 'caution' && /No cached active data/i.test(offlineMiss.message)
    },
    {
      id: 'online_refresh_message_present',
      pass: onlineRefresh.tone === 'signal' && /Refreshing latest marketplace state/i.test(onlineRefresh.message)
    },
    {
      id: 'quiet_hours_window_calculation',
      pass: quietAt23 === true && quietAt12 === false
    }
  ];

  const output = {
    check_id: 'SC-RL-03',
    generated_at: new Date().toISOString(),
    stale_banner_examples: {
      offline_hit: offlineHit,
      offline_miss: offlineMiss,
      online_refresh: onlineRefresh
    },
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
