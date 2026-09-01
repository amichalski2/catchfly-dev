import type { IncidentTimelinePoint } from '@catchfly/core/types.ts';

export type StatusKind = IncidentTimelinePoint['kind'];

const MARK: Record<StatusKind, string> = {
  control: '/brand/mark-control.webp',
  regression: '/brand/mark-regressed.webp',
  decoy: '/brand/mark-decoy.webp',
  recovery: '/brand/mark-recovery.webp',
};

const LABEL: Record<StatusKind, string> = {
  control: 'Clean control',
  regression: 'Confirmed',
  decoy: 'False lead',
  recovery: 'Recovered',
};

export function StatusMark({
  kind,
  detail,
  size = 20,
}: {
  kind: StatusKind;
  detail?: string;
  size?: number;
}) {
  const label = detail ? `${LABEL[kind]} — ${detail}` : LABEL[kind];
  return (
    <span className={`status-mark status-mark-${kind}`} tabIndex={0} role="img" aria-label={label}>
      <img src={MARK[kind]} alt="" width={size} height={size} aria-hidden="true" />
      <span className="status-mark-tip" role="presentation">
        {label}
      </span>
    </span>
  );
}
