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

  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  });

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
