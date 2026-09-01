import type { SessionOutcome } from '@catchfly/core/session-types.ts';

const MARK: Record<SessionOutcome, string> = {
  completed: '/brand/mark-recovery.webp',
  failed: '/brand/mark-regressed.webp',
  abandoned: '/brand/mark-decoy.webp',
  unknown: '/brand/mark-control.webp',
};

const LABEL: Record<SessionOutcome, string> = {
  completed: 'Task completed',
  failed: 'Task failed',
  abandoned: 'Agent gave up part-way',
  unknown: 'No verdict recorded',
};

export function OutcomeMark({
  outcome,
  detail,
  size = 16,
}: {
  outcome: SessionOutcome;
  detail?: string;
  size?: number;
}) {
  const label = detail ? `${LABEL[outcome]} — ${detail}` : LABEL[outcome];

  return (
    <span
      className={`status-mark outcome-mark outcome-mark-${outcome}`}
      tabIndex={0}
      role="img"
      aria-label={label}
    >
      <img src={MARK[outcome]} alt="" width={size} height={size} aria-hidden="true" />
      <span className="status-mark-tip" role="presentation">
        {label}
      </span>
    </span>
  );
}
