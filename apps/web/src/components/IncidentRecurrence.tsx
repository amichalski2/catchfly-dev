import type { IncidentTimelinePoint } from '@catchfly/core/types.ts';

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

type Props = {
  timeline: IncidentTimelinePoint[];
  scenarioId: string;
  kind: IncidentTimelinePoint['kind'];
};

export function IncidentRecurrence({ timeline, scenarioId, kind }: Props) {
  if (timeline.length < 2) return null;

  const hits = timeline
    .map((point, index) => ({ point, index }))
    .filter((entry) => entry.point.scenarioId === scenarioId);

  const label =
    hits.length > 0
      ? `Struck at release ${hits
          .map((hit) => `${hit.index + 1} of ${timeline.length} (${percent(hit.point.evalSuccessRate)} eval)`)
          .join(' and release ')}.`
      : `Not seen in these ${timeline.length} releases.`;

  return (
    <div className={`recur recur-${kind}`} role="img" aria-label={label}>
      {timeline.map((point, index) => {
        const struck = point.scenarioId === scenarioId;
        const startsCycle = index > 0 && point.kind === 'control';
        const isEnd = index === 0 || index === timeline.length - 1;
        return (
          <span
            key={point.appVersionId}
            className={`recur-slot${struck ? ' is-struck' : ''}${startsCycle ? ' starts-cycle' : ''}`}
            title={
              struck
                ? `Release ${index + 1} · ${percent(point.evalSuccessRate)} eval`
                : `Release ${index + 1}`
            }
          >
            <i aria-hidden="true" />
            {struck || isEnd ? (
              <b className={`tabular${struck ? '' : ' is-end'}`}>
                {String(index + 1).padStart(2, '0')}
              </b>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
