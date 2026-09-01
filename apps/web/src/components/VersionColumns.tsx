/**
 * Small multiples: one facet per model, a column per app version.
 *
 * The job here is "one series is the point, the rest are context", so this is an
 * emphasis chart — the candidate version carries the accent, everything else is
 * the de-emphasis neutral. Using a categorical palette across versions would
 * bury exactly the column the reader came for.
 */

import { useState } from 'react';

export type VersionColumn = {
  runId: string;
  version: string;
  value: number;
  detail: string;
};

export type VersionFacet = {
  model: string;
  columns: VersionColumn[];
};

type Props = {
  facets: VersionFacet[];
  emphasisRunId?: string;
  onSelect?: (runId: string) => void;
};

/** Every column carries its own value, which is what keeps a truncated scale honest. */
function AxisNote({ floor }: { floor: number }) {
  return <p className="axis-note">Scale starts at {Math.round(floor * 100)}% — every column is labelled.</p>;
}

/**
 * Truncating the axis makes small differences between high rates readable, but a
 * fixed floor turns any value below it into an invisible stub. So the floor is
 * derived: one decile below the worst run, and never above 80%.
 */
function floorFor(facets: VersionFacet[]): number {
  const values = facets.flatMap((facet) => facet.columns.map((column) => column.value));
  const lowest = values.length > 0 ? Math.min(...values) : 1;
  return Math.max(0, Math.min(0.8, Math.floor((lowest - 0.05) * 10) / 10));
}

const PLOT_HEIGHT = 132;

export function VersionColumns({ facets, emphasisRunId, onSelect }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const floor = floorFor(facets);

  return (
    <>
      <div className="facets">
      {facets.map((facet) => (
        <figure key={facet.model} className="facet">
          <figcaption className="facet-title">{facet.model}</figcaption>
          <div className="facet-plot" style={{ height: PLOT_HEIGHT }}>
            <span className="facet-gridline" style={{ bottom: 0 }} />
            {facet.columns.map((column) => {
              const share = Math.max((column.value - floor) / (1 - floor), 0.02);
              const emphasised = emphasisRunId === undefined || emphasisRunId === column.runId;
              const interactive = onSelect !== undefined;
              const Column = interactive ? 'button' : 'div';
              return (
                <Column
                  key={column.runId}
                  className={`facet-col${interactive ? ' is-interactive' : ''}`}
                  onMouseEnter={() => setHovered(column.runId)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(column.runId)}
                  onBlur={() => setHovered(null)}
                  {...(interactive
                    ? { type: 'button' as const, onClick: () => onSelect(column.runId) }
                    : {})}
                >
                  <span className="facet-value tabular">{(column.value * 100).toFixed(1)}%</span>
                  <span
                    className={`facet-bar mark ${emphasised ? 'mark-emphasis' : 'mark-quiet'}`}
                    style={{
                      height: `${share * 100}%`,
                      opacity: hovered === null || hovered === column.runId ? 1 : 0.55,
                    }}
                  />
                  <span className="facet-label">{column.version}</span>
                  {hovered === column.runId ? (
                    <span className="facet-tip" role="tooltip">
                      {column.detail}
                    </span>
                  ) : null}
                </Column>
              );
            })}
          </div>
        </figure>
      ))}
      </div>
      <AxisNote floor={floor} />
    </>
  );
}
