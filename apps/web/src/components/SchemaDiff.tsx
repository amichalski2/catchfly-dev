import { schemaUnchanged } from '@catchfly/core/schema-diff.ts';
import type { ToolSchemaDiff } from '@catchfly/core/session-types.ts';

export function SchemaDiff({ diff }: { diff: ToolSchemaDiff }) {
  if (schemaUnchanged(diff)) return <p className="muted">Unchanged.</p>;
  return (
    <div className="schema-diff">
      {diff.descriptionChanged ? (
        <>
          <p className="schema-line schema-before">
            <span className="eyebrow">was</span> {diff.before ?? <em>not declared</em>}
          </p>
          <p className="schema-line schema-after">
            <span className="eyebrow">now</span> {diff.after ?? <em>no longer declared</em>}
          </p>
        </>
      ) : null}
      {diff.addedProps.map((prop) => (
        <span key={`add-${prop}`} className="chip mark-gained">
          + {prop}
        </span>
      ))}
      {diff.removedProps.map((prop) => (
        <span key={`remove-${prop}`} className="chip mark-lost">
          − {prop}
        </span>
      ))}
      {diff.changedProps.map((prop) => (
        <span key={`change-${prop}`} className="chip mark-emphasis">
          ~ {prop}
        </span>
      ))}
    </div>
  );
}
