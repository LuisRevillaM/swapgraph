import { formatIsoShort } from '../../utils/format.mjs';
import { actorDisplayLabel } from '../../pilot/trackATheme.mjs';

const TERMINAL_LEG_STATES = new Set(['released', 'refunded']);
const DEPOSITED_LEG_STATES = new Set(['deposited', 'released', 'refunded']);
const TIMELINE_STATE_VALUES = new Set([
  'proposed',
  'accepted',
  'escrow.pending',
  'escrow.ready',
  'executing',
  'completed',
  'failed'
]);

function toMs(iso) {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeState(state) {
  return TIMELINE_STATE_VALUES.has(state) ? state : 'proposed';
}

function actorTag(actorId, viewerActorId) {
  return actorDisplayLabel({
    actorId,
    viewerActorId,
    includeAtFallback: true
  });
}

export function inferViewerActorId({ timeline = null, intents = [], viewerActorIdHint = null } = {}) {
  const hinted = String(viewerActorIdHint ?? '').trim();
  if (hinted) return hinted;

  for (const intent of intents) {
    const actorId = String(intent?.actor?.id ?? '').trim();
    if (actorId) return actorId;
  }

  const legs = Array.isArray(timeline?.legs) ? timeline.legs : [];
  for (const [index, leg] of legs.entries()) {
    const candidate = String(leg?.fromActor?.id ?? '').trim();
    if (candidate && candidate !== 'redacted' && candidate !== 'unknown') return candidate;
  }

  for (const leg of legs) {
    const candidate = String(leg?.toActor?.id ?? '').trim();
    if (candidate && candidate !== 'redacted' && candidate !== 'unknown') return candidate;
  }

  return null;
}

function stageProgressPercent({ state, viewerLeg }) {
  if (state === 'completed') return 100;
  if (state === 'failed') return 100;
  if (state === 'executing') return 84;
  if (state === 'escrow.ready') return 68;
  if (state === 'escrow.pending') {
    if (viewerLeg && DEPOSITED_LEG_STATES.has(viewerLeg.status)) return 54;
    return 42;
  }
  if (state === 'accepted') return 24;
  return 12;
}

function waitReasonFromState({ state, viewerLeg, pendingOtherLegs, nowMs }) {
  const earliestPendingDeadline = pendingOtherLegs
    .map(leg => toMs(leg?.depositDeadlineAt))
    .filter(ms => ms !== null)
    .sort((a, b) => a - b)[0] ?? null;

  if (state === 'escrow.pending') {
    if (viewerLeg && viewerLeg.status === 'pending') {
      return {
        code: 'your_deposit_required',
        headline: 'Your deposit is required',
        detail: `Confirm deposit before ${formatIsoShort(viewerLeg.depositDeadlineAt)}.`,
        deadlineAt: viewerLeg.depositDeadlineAt
      };
    }

    if (pendingOtherLegs.length > 0) {
      const tags = pendingOtherLegs
        .map(leg => actorTag(leg?.fromActor?.id, null))
        .slice(0, 2)
        .join(', ');
      const suffix = pendingOtherLegs.length > 2 ? ', and others' : '';
      const hoursRemaining = earliestPendingDeadline !== null
        ? Math.max(0, Math.ceil((earliestPendingDeadline - nowMs) / (60 * 60 * 1000)))
        : null;
      return {
        code: 'awaiting_counterparty_deposit',
        headline: `Awaiting ${tags}${suffix} deposit`,
        detail: hoursRemaining === null
          ? 'Waiting on counterparty deposit confirmations.'
          : `${hoursRemaining}h remaining in deposit window.`,
        deadlineAt: earliestPendingDeadline === null ? null : new Date(earliestPendingDeadline).toISOString()
      };
    }

    return {
      code: 'deposit_reconciliation',
      headline: 'Reconciling deposit updates',
      detail: 'Deposit statuses are syncing across participants.',
      deadlineAt: null
    };
  }

  if (state === 'escrow.ready') {
    return {
      code: 'awaiting_execution_start',
      headline: 'All deposits received',
      detail: 'Awaiting settlement execution start.',
      deadlineAt: null
    };
  }

  if (state === 'executing') {
    return {
      code: 'execution_in_progress',
      headline: 'Execution in progress',
      detail: 'Asset transfers are being finalized.',
      deadlineAt: null
    };
  }

  if (state === 'completed') {
    return {
      code: 'receipt_available',
      headline: 'Settlement completed',
      detail: 'Receipt is available for verification.',
      deadlineAt: null
    };
  }

  if (state === 'failed') {
    const viewerRefunded = viewerLeg?.status === 'refunded';
    return {
      code: viewerRefunded ? 'counterparty_timeout_refund' : 'cycle_failed',
      headline: viewerRefunded ? 'Counterparty timeout' : 'Cycle failed',
      detail: viewerRefunded ? 'Your deposited asset was refunded safely.' : 'Settlement was unwound safely.',
      deadlineAt: null
    };
  }

  if (state === 'accepted') {
    return {
      code: 'awaiting_deposit_window',
      headline: 'Commit accepted',
      detail: 'Waiting for settlement deposit window to start.',
      deadlineAt: null
    };
  }

  return {
    code: 'cycle_proposed',
    headline: 'Proposal phase',
    detail: 'Awaiting participant commits.',
    deadlineAt: null
  };
}

function actionForState({ actionKey, state, viewerLeg, viewerActorId }) {
  if (actionKey === 'confirm_deposit') {
    if (!viewerActorId) {
      return { enabled: false, reason: 'Only participants can confirm deposits.' };
    }
    if (state !== 'escrow.pending') {
      return { enabled: false, reason: 'Deposit confirmation window is not active.' };
    }
    if (!viewerLeg) {
      return { enabled: false, reason: 'You are not a depositor in this cycle.' };
    }
    if (viewerLeg.status !== 'pending') {
      return { enabled: false, reason: 'Your deposit is already confirmed.' };
    }
    return { enabled: true, reason: null };
  }

  if (actionKey === 'begin_execution') {
    if (state !== 'escrow.ready') {
      return { enabled: false, reason: 'Execution starts after all deposits are confirmed.' };
    }
    return { enabled: false, reason: 'Execution is triggered by the settlement operator.' };
  }

  if (actionKey === 'complete_settlement') {
    if (state !== 'executing') {
      return { enabled: false, reason: 'Completion is available only during execution.' };
    }
    return { enabled: false, reason: 'Completion is triggered by the settlement operator.' };
  }

  if (actionKey === 'open_receipt') {
    if (state !== 'completed' && state !== 'failed') {
      return { enabled: false, reason: 'Receipt opens after terminal settlement state.' };
    }
    return { enabled: true, reason: null };
  }

  return { enabled: false, reason: 'Unsupported action.' };
}

function timelineEntries({ state, legs, viewerActorId, waitReason, updatedAt }) {
  const rows = [
    {
      key: 'commit_ready',
      title: 'Commit accepted',
      detail: 'All participants committed to the cycle.',
      timestamp: updatedAt,
      kind: 'done'
    }
  ];

  for (const leg of legs) {
    const fromTag = actorTag(leg?.fromActor?.id, viewerActorId);
    const isViewer = viewerActorId && leg?.fromActor?.id === viewerActorId;
    const labelPrefix = isViewer ? 'Your deposit' : `${fromTag} deposit`;
    const status = leg?.status ?? 'pending';
    let detail = `Status: ${status}.`;
    if (status === 'pending') detail = `Due ${formatIsoShort(leg?.depositDeadlineAt)}.`;
    if (status === 'deposited') detail = 'Deposit confirmed.';
    if (status === 'released') detail = 'Asset released to counterparty.';
    if (status === 'refunded') detail = 'Asset refunded after unwind.';

    rows.push({
      key: `leg_${leg?.legId ?? String(index)}`,
      title: labelPrefix,
      detail,
      timestamp: status === 'pending' ? leg?.depositDeadlineAt : updatedAt,
      kind: status === 'pending' ? 'pending' : (status === 'refunded' ? 'danger' : 'done')
    });
  }

  if (state === 'escrow.ready' || state === 'executing' || state === 'completed') {
    rows.push({
      key: 'escrow_ready',
      title: 'All deposits received',
      detail: 'Cycle is ready to execute.',
      timestamp: updatedAt,
      kind: 'done'
    });
  }

  if (state === 'executing' || state === 'completed') {
    rows.push({
      key: 'executing',
      title: 'Execution started',
      detail: 'Transfer operations are running.',
      timestamp: updatedAt,
      kind: state === 'executing' ? 'active' : 'done'
    });
  }

  if (state === 'completed') {
    rows.push({
      key: 'receipt_issued',
      title: 'Receipt issued',
      detail: 'Settlement completed and verified.',
      timestamp: updatedAt,
      kind: 'done'
    });
  }

  if (state === 'failed') {
    rows.push({
      key: 'failed',
      title: 'Cycle unwound',
      detail: waitReason.detail,
      timestamp: updatedAt,
      kind: 'danger'
    });
  }

  return rows;
}

export function buildActiveTimelineModel({
  timeline = null,
  intents = [],
  viewerActorIdHint = null,
  nowMs = Date.now()
} = {}) {
  if (!timeline) return null;

  const state = safeState(timeline.state);
  const legs = Array.isArray(timeline.legs) ? timeline.legs : [];
  const viewerActorId = inferViewerActorId({ timeline, intents, viewerActorIdHint });
  const viewerLeg = legs.find(leg => viewerActorId && leg?.fromActor?.id === viewerActorId) ?? null;
  const pendingOtherLegs = legs.filter(leg => leg?.status === 'pending' && leg?.fromActor?.id !== viewerActorId);
  const waitReason = waitReasonFromState({ state, viewerLeg, pendingOtherLegs, nowMs });
  const progressPercent = stageProgressPercent({ state, viewerLeg });
  const completedLegs = legs.filter(leg => TERMINAL_LEG_STATES.has(leg?.status) || leg?.status === 'deposited').length;

  const actions = [
    {
      key: 'confirm_deposit',
      label: 'Confirm your deposit',
      eventType: 'active.confirmDeposit',
      ...actionForState({ actionKey: 'confirm_deposit', state, viewerLeg, viewerActorId })
    },
    {
      key: 'begin_execution',
      label: 'Begin execution',
      eventType: 'active.beginExecution',
      ...actionForState({ actionKey: 'begin_execution', state, viewerLeg, viewerActorId })
    },
    {
      key: 'complete_settlement',
      label: 'Complete settlement',
      eventType: 'active.completeSettlement',
      ...actionForState({ actionKey: 'complete_settlement', state, viewerLeg, viewerActorId })
    },
    {
      key: 'open_receipt',
      label: 'Open receipt',
      eventType: 'active.openReceipt',
      ...actionForState({ actionKey: 'open_receipt', state, viewerLeg, viewerActorId })
    }
  ];

  return {
    cycleId: timeline.cycleId ?? '',
    state,
    updatedAt: timeline.updatedAt ?? null,
    updatedAtLabel: formatIsoShort(timeline.updatedAt),
    waitReasonCode: waitReason.code,
    statusHeadline: waitReason.headline,
    statusDetail: waitReason.detail,
    deadlineAt: waitReason.deadlineAt,
    deadlineLabel: formatIsoShort(waitReason.deadlineAt),
    progressPercent,
    progressLabel: `${completedLegs}/${legs.length} deposits acknowledged`,
    viewerActorId,
    viewerLeg,
    actions,
    entries: timelineEntries({
      state,
      legs,
      viewerActorId,
      waitReason,
      updatedAt: timeline.updatedAt
    })
  };
}
