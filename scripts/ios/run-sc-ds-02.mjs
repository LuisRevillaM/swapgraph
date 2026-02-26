#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const iosTokenPath = path.join(repoRoot, 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Resources/marketplace_design_tokens.json');

const tokens = JSON.parse(readFileSync(iosTokenPath, 'utf8'));
const floorPx = 11.3;

const requiredReadable = ['sm', 'data', 'base', 'md', 'lg', 'xl'];
const readabilityChecks = requiredReadable.map(key => {
  const value = Number(tokens.typography?.scale?.[key]?.px ?? NaN);
  return {
    token: key,
    px: value,
    floor_px: floorPx,
    pass: Number.isFinite(value) && value >= floorPx
  };
});

const decorativeToken = Number(tokens.typography?.scale?.xs?.px ?? NaN);

function parseHex(hex) {
  const cleaned = String(hex ?? '').trim().replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return null;
  }

  return {
    r: parseInt(cleaned.slice(0, 2), 16) / 255,
    g: parseInt(cleaned.slice(2, 4), 16) / 255,
    b: parseInt(cleaned.slice(4, 6), 16) / 255
  };
}

function luminance(channelValue) {
  if (channelValue <= 0.03928) {
    return channelValue / 12.92;
  }
  return ((channelValue + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foregroundHex, backgroundHex) {
  const fg = parseHex(foregroundHex);
  const bg = parseHex(backgroundHex);
  if (!fg || !bg) {
    return NaN;
  }

  const lFg = 0.2126 * luminance(fg.r) + 0.7152 * luminance(fg.g) + 0.0722 * luminance(fg.b);
  const lBg = 0.2126 * luminance(bg.r) + 0.7152 * luminance(bg.g) + 0.0722 * luminance(bg.b);
  const lighter = Math.max(lFg, lBg);
  const darker = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

const contrastRequired = ['ink', 'ink-2', 'ink-3'];
const contrastChecks = contrastRequired.map(name => {
  const ratio = contrastRatio(tokens.color[name], tokens.color.canvas);
  return {
    foreground: name,
    background: 'canvas',
    ratio,
    minimum: 4.5,
    pass: Number.isFinite(ratio) && ratio >= 4.5
  };
});

const decorativeRatio = contrastRatio(tokens.color['ink-4'], tokens.color.canvas);

const readabilityPass = readabilityChecks.every(entry => entry.pass);
const contrastPass = contrastChecks.every(entry => entry.pass);

const typographyFiles = [
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/AppShell/AppShellView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Items/ItemsView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Intents/IntentsView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Notifications/NotificationPreferencesView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Inbox/InboxView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/ProposalDetail/ProposalDetailView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Active/ActiveView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/Receipts/ReceiptsView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/UI/FallbackStateView.swift',
  'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/UI/StaleDataBannerView.swift'
];

const typographyUsageChecks = typographyFiles.map(relativePath => {
  const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const hasSystemFontCalls = /font\(\.system\(/.test(source);
  const hasMarketplaceTypographyCalls = /font\(\.marketplace\(/.test(source);
  return {
    file: relativePath,
    has_system_font_calls: hasSystemFontCalls,
    has_marketplace_typography_calls: hasMarketplaceTypographyCalls,
    pass: !hasSystemFontCalls && hasMarketplaceTypographyCalls
  };
});

const typographyProviderSource = readFileSync(
  path.join(repoRoot, 'ios/MarketplaceClient/Sources/MarketplaceClientFoundation/DesignSystem/Typography.swift'),
  'utf8'
);
const hasMarketplaceFontExtension = /extension Font[\s\S]*static func marketplace\(_ role: TypographyRole\)/.test(
  typographyProviderSource
);

const typographyEnforcementPass =
  typographyUsageChecks.every(entry => entry.pass) &&
  hasMarketplaceFontExtension;

const report = {
  check_id: 'SC-DS-02',
  overall: readabilityPass && contrastPass && typographyEnforcementPass,
  readability_floor_px: floorPx,
  readability_checks: readabilityChecks,
  decorative_token: {
    token: 'xs',
    px: decorativeToken,
    allowed_below_floor: true
  },
  contrast_checks: contrastChecks,
  decorative_contrast: {
    foreground: 'ink-4',
    background: 'canvas',
    ratio: decorativeRatio,
    required_for_informational_text: false
  },
  typography_enforcement: {
    pass: typographyEnforcementPass,
    has_marketplace_font_extension: hasMarketplaceFontExtension,
    file_checks: typographyUsageChecks
  }
};

if (!report.overall) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(2);
}

console.log(JSON.stringify(report, null, 2));
