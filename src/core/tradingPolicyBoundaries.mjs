export function actorKey(actor) {
  return `${actor?.type}:${actor?.id}`;
}

export function effectiveActorForDelegation({ actor, auth }) {
  if (actor?.type === 'agent') {
    return auth?.delegation?.subject_actor ?? null;
  }
  return actor;
}

export function policyForDelegatedActor({ actor, auth }) {
  if (actor?.type === 'agent') {
    return auth?.delegation?.policy ?? null;
  }
  return null;
}

function finiteNumberOrNull(x) {
  return Number.isFinite(x) ? x : null;
}

export function resolvePolicyNowIso({ auth }) {
  return auth?.now_iso ?? process.env.AUTHZ_NOW_ISO ?? new Date().toISOString();
}

export function dayKeyFromIsoUtc(nowIso) {
  const ms = Date.parse(nowIso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function intentMaxUsd(intent) {
  const v = finiteNumberOrNull(intent?.value_band?.max_usd);
  return v ?? 0;
}

export function activeIntentMaxUsd(intent) {
  if (!intent) return 0;
  if (intent?.status === 'cancelled') return 0;
  return intentMaxUsd(intent);
}

export function dailySpendDeltaForIntentMutation({ previousIntent, nextIntent }) {
  const prev = activeIntentMaxUsd(previousIntent);
  const next = activeIntentMaxUsd(nextIntent);
  return next - prev;
}

export function evaluateIntentAgainstTradingPolicy({ policy, intent }) {
  if (!policy) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation policy is required',
      details: { policy: null }
    };
  }

  const violations = [];

  const maxUsd = finiteNumberOrNull(intent?.value_band?.max_usd);
  if (Number.isFinite(policy.max_value_per_swap_usd) && Number.isFinite(maxUsd) && maxUsd > policy.max_value_per_swap_usd) {
    violations.push({ field: 'value_band.max_usd', max_allowed: policy.max_value_per_swap_usd, actual: maxUsd });
  }

  const maxCycle = finiteNumberOrNull(intent?.trust_constraints?.max_cycle_length);
  if (Number.isFinite(policy.max_cycle_length) && Number.isFinite(maxCycle) && maxCycle > policy.max_cycle_length) {
    violations.push({ field: 'trust_constraints.max_cycle_length', max_allowed: policy.max_cycle_length, actual: maxCycle });
  }

  if (typeof policy.require_escrow === 'boolean') {
    const reqEscrow = intent?.settlement_preferences?.require_escrow;
    if (typeof reqEscrow === 'boolean' && reqEscrow !== policy.require_escrow) {
      violations.push({ field: 'settlement_preferences.require_escrow', required: policy.require_escrow, actual: reqEscrow });
    }
  }

  if (violations.length > 0) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation policy violation',
      details: { violations }
    };
  }

  return { ok: true };
}

export function evaluateProposalAgainstTradingPolicy({ policy, proposal }) {
  if (!policy) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation policy is required',
      details: { policy: null }
    };
  }

  const violations = [];

  const cycleLength = Array.isArray(proposal?.participants) ? proposal.participants.length : null;
  if (Number.isFinite(policy.max_cycle_length) && Number.isFinite(cycleLength) && cycleLength > policy.max_cycle_length) {
    violations.push({ field: 'participants.length', max_allowed: policy.max_cycle_length, actual: cycleLength });
  }

  const confidence = proposal?.confidence_score;
  if (Number.isFinite(policy.min_confidence_score) && Number.isFinite(confidence) && confidence < policy.min_confidence_score) {
    violations.push({ field: 'confidence_score', min_required: policy.min_confidence_score, actual: confidence });
  }

  if (violations.length > 0) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation policy violation',
      details: { violations }
    };
  }

  return { ok: true };
}

function parseClockMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hh = Number.parseInt(m[1], 10);
  const mm = Number.parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return (hh * 60) + mm;
}

function clockMinutesForIsoInTz(iso, tz) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;

  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return null;
  }

  const parts = fmt.formatToParts(d);
  const hh = Number.parseInt(parts.find(p => p.type === 'hour')?.value ?? '', 10);
  const mm = Number.parseInt(parts.find(p => p.type === 'minute')?.value ?? '', 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return (hh * 60) + mm;
}

export function evaluateQuietHoursPolicy({ policy, nowIso }) {
  const qh = policy?.quiet_hours;
  if (!qh) return { ok: true, in_quiet_hours: false, skipped: true };

  if (!nowIso) {
    return {
      ok: true,
      in_quiet_hours: false,
      skipped: true,
      details: { reason: 'now_iso_not_provided' }
    };
  }

  const startMin = parseClockMinutes(qh.start);
  const endMin = parseClockMinutes(qh.end);
  if (startMin === null || endMin === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid delegation quiet_hours window',
      details: { quiet_hours: qh }
    };
  }

  const tz = qh.tz || 'UTC';
  const nowMin = clockMinutesForIsoInTz(nowIso, tz);
  if (nowMin === null) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid now_iso for quiet-hours evaluation',
      details: { now_iso: nowIso, quiet_hours: qh }
    };
  }

  let inQuietHours;
  if (startMin === endMin) {
    inQuietHours = true;
  } else if (startMin < endMin) {
    inQuietHours = nowMin >= startMin && nowMin < endMin;
  } else {
    // wraps midnight
    inQuietHours = nowMin >= startMin || nowMin < endMin;
  }

  return {
    ok: true,
    in_quiet_hours: inQuietHours,
    skipped: false,
    details: {
      now_iso: nowIso,
      tz,
      quiet_hours: qh,
      now_minutes: nowMin,
      start_minutes: startMin,
      end_minutes: endMin
    }
  };
}

function consentTierRank(tier) {
  if (tier === 'step_up') return 1;
  if (tier === 'passkey') return 2;
  return 0;
}

export function evaluateHighValueConsentForIntent({ policy, intent, auth, nowIso }) {
  const threshold = finiteNumberOrNull(policy?.high_value_consent_threshold_usd);
  const maxUsd = intentMaxUsd(intent);

  if (!Number.isFinite(threshold)) {
    return { ok: true, required: false, skipped: true };
  }

  if (!Number.isFinite(maxUsd) || maxUsd <= threshold) {
    return { ok: true, required: false, skipped: false };
  }

  const consent = auth?.user_consent;
  if (!consent || typeof consent !== 'object') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation consent required for high-value intent',
      details: {
        reason_code: 'consent_required',
        threshold_usd: threshold,
        max_usd: maxUsd
      }
    };
  }

  if (typeof consent.consent_id !== 'string' || consent.consent_id.trim().length < 1) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid user_consent payload',
      details: {
        reason_code: 'consent_malformed',
        threshold_usd: threshold,
        max_usd: maxUsd,
        user_consent: consent
      }
    };
  }

  const tierEnforced = process.env.POLICY_CONSENT_TIER_ENFORCE === '1';
  const requiredTier = maxUsd > (threshold * 1.5) ? 'passkey' : 'step_up';

  if (tierEnforced) {
    const consentTier = consent?.consent_tier;
    const consentProof = consent?.consent_proof;

    if (typeof consentTier !== 'string' || consentTier.trim().length < 1) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'delegation consent tier required',
        details: {
          reason_code: 'consent_tier_required',
          threshold_usd: threshold,
          max_usd: maxUsd,
          required_tier: requiredTier,
          consent_id: consent.consent_id
        }
      };
    }

    const providedTier = consentTier.trim();
    const requiredRank = consentTierRank(requiredTier);
    const providedRank = consentTierRank(providedTier);

    if (providedRank === 0) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid consent tier',
        details: {
          reason_code: 'consent_tier_invalid',
          threshold_usd: threshold,
          max_usd: maxUsd,
          required_tier: requiredTier,
          consent_tier: providedTier,
          consent_id: consent.consent_id
        }
      };
    }

    if (providedRank < requiredRank) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'delegation consent tier insufficient',
        details: {
          reason_code: 'consent_tier_insufficient',
          threshold_usd: threshold,
          max_usd: maxUsd,
          required_tier: requiredTier,
          consent_tier: providedTier,
          consent_id: consent.consent_id
        }
      };
    }

    if (typeof consentProof !== 'string' || consentProof.trim().length < 1) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'delegation consent proof required',
        details: {
          reason_code: 'consent_proof_required',
          threshold_usd: threshold,
          max_usd: maxUsd,
          required_tier: requiredTier,
          consent_tier: providedTier,
          consent_id: consent.consent_id
        }
      };
    }
  }

  if (Number.isFinite(consent.approved_max_usd) && consent.approved_max_usd < maxUsd) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation consent limit exceeded',
      details: {
        reason_code: 'consent_limit_exceeded',
        threshold_usd: threshold,
        max_usd: maxUsd,
        approved_max_usd: consent.approved_max_usd,
        consent_id: consent.consent_id,
        required_tier: requiredTier,
        consent_tier: consent?.consent_tier ?? null
      }
    };
  }

  if (consent.expires_at) {
    const nowMs = Date.parse(nowIso ?? '');
    const expMs = Date.parse(consent.expires_at);
    if (!Number.isFinite(nowMs) || !Number.isFinite(expMs)) {
      return {
        ok: false,
        code: 'CONSTRAINT_VIOLATION',
        message: 'invalid consent expiry timestamps',
        details: {
          reason_code: 'consent_invalid_expiry',
          now_iso: nowIso ?? null,
          expires_at: consent.expires_at,
          consent_id: consent.consent_id
        }
      };
    }

    if (nowMs > expMs) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'delegation consent expired',
        details: {
          reason_code: 'consent_expired',
          now_iso: nowIso,
          expires_at: consent.expires_at,
          consent_id: consent.consent_id
        }
      };
    }
  }

  return {
    ok: true,
    required: true,
    skipped: false,
    details: {
      threshold_usd: threshold,
      max_usd: maxUsd,
      required_tier: requiredTier,
      tier_enforced: tierEnforced,
      consent_tier: consent?.consent_tier ?? null,
      consent_id: consent.consent_id,
      approved_max_usd: finiteNumberOrNull(consent.approved_max_usd)
    }
  };
}

export function evaluateDailySpendCapForIntent({
  policy,
  subjectActor,
  nowIso,
  spendByActorDay,
  existingIntent,
  nextIntent
}) {
  const capUsd = finiteNumberOrNull(policy?.max_value_per_day_usd);
  if (!Number.isFinite(capUsd)) {
    return { ok: true, enforced: false, skipped: true };
  }

  const dayKey = dayKeyFromIsoUtc(nowIso);
  if (!dayKey) {
    return {
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      message: 'invalid now_iso for daily spend policy',
      details: { now_iso: nowIso ?? null }
    };
  }

  const subject = actorKey(subjectActor);
  const usedUsd = finiteNumberOrNull(spendByActorDay?.[subject]?.[dayKey]) ?? 0;
  const deltaUsd = dailySpendDeltaForIntentMutation({ previousIntent: existingIntent, nextIntent });
  const projectedUsd = usedUsd + deltaUsd;

  if (projectedUsd > capUsd) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      message: 'delegation daily value cap exceeded',
      details: {
        reason_code: 'daily_cap_exceeded',
        cap_usd: capUsd,
        used_usd: usedUsd,
        delta_usd: deltaUsd,
        projected_usd: projectedUsd,
        day_key: dayKey,
        subject_actor: subjectActor
      }
    };
  }

  return {
    ok: true,
    enforced: true,
    skipped: false,
    details: {
      cap_usd: capUsd,
      used_usd: usedUsd,
      delta_usd: deltaUsd,
      projected_usd: projectedUsd,
      day_key: dayKey,
      subject_actor: subjectActor
    }
  };
}
