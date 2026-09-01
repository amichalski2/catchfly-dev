/**
 * The console, in one file: a list of what was submitted, a sheet for whatever
 * is open, and a rail showing what has been done to it and by whom.
 *
 * Every control here calls the same store action the agent's tool executor
 * calls. There is deliberately no second write path — that is the claim the
 * whole demo rests on, and it is easier to believe when the code has only one.
 */

import { appFactsById, eligibilityVerdicts, injectionFindings, repoFiles } from '@catchfly/devpost-world/app-data.ts'
import { catalog, catalogById, CRITERIA, TRACKS, type Track } from '@catchfly/devpost-world/catalog.ts'
import type { WebMcpStatus } from '@catchfly/webmcp/spec.ts'

import { useConsoleStore } from './state/store.ts'
import { labelFor } from './version.ts'

function Masthead({ status }: { status: WebMcpStatus }) {
  const version = useConsoleStore((state) => state.version)
  const flags = useConsoleStore((state) => state.flags.length)
  const listed = useConsoleStore((state) => Object.values(state.shortlists).flat().length)

  return (
    <header className="masthead">
      <h1>Devpost Review Console</h1>
      <span className="sub">
        {catalog.length} submissions · {listed} shortlisted · {flags} flagged
      </span>
      <span className="spacer" />
      <span className="badge" title={`Serving the ${version} tool manifest`}>
        {labelFor(version)}
      </span>
      <span className={`badge ${status === 'active' ? 'is-live' : 'is-off'}`}>
        {status === 'active' ? 'agent tools live' : 'no agent connected'}
      </span>
    </header>
  )
}

function SubmissionList() {
  const track = useConsoleStore((state) => state.track)
  const query = useConsoleStore((state) => state.query)
  const openId = useConsoleStore((state) => state.openSubmissionId)
  const setTrack = useConsoleStore((state) => state.setTrack)
  const setQuery = useConsoleStore((state) => state.setQuery)
  const open = useConsoleStore((state) => state.openSubmission)
  const flags = useConsoleStore((state) => state.flags)
  const shortlists = useConsoleStore((state) => state.shortlists)
  const scores = useConsoleStore((state) => state.scores)

  const needle = query.trim().toLowerCase()
  const listedIds = new Set(Object.values(shortlists).flat())
  const flaggedIds = new Set(flags.map((flag) => flag.submissionId))

  const rows = catalog
    .filter((entry) => !track || entry.track === track)
    .filter(
      (entry) =>
        needle === '' ||
        `${entry.id} ${entry.title} ${entry.team} ${entry.description}`.toLowerCase().includes(needle),
    )

  return (
    <div className="column">
      <span className="eyebrow">Submissions</span>
      <input
        className="search"
        type="search"
        placeholder="Search title, team or description"
        value={query}
        onChange={(event) => setQuery(event.target.value, 'human')}
      />
      <div className="chips">
        <button type="button" className={`chip${track === null ? ' is-on' : ''}`} onClick={() => setTrack(null)}>
          All
        </button>
        {TRACKS.map((name) => (
          <button
            key={name}
            type="button"
            className={`chip${track === name ? ' is-on' : ''}`}
            onClick={() => setTrack(track === name ? null : name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="entries">
        {rows.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`entry${entry.id === openId ? ' is-open' : ''}`}
            onClick={() => open(entry.id, 'human')}
          >
            <span className="id">{entry.id}</span>{' '}
            <span className="title">{entry.title}</span>
            <span className="marks">
              {flaggedIds.has(entry.id) ? <span className="mark flag">flag</span> : null}
              {listedIds.has(entry.id) ? <span className="mark listed">list</span> : null}
              {scores[entry.id] ? (
                <span className="mark scored">{Object.keys(scores[entry.id]).length}/4</span>
              ) : null}
            </span>
            <div className="meta">
              {entry.track} · {entry.team}
            </div>
          </button>
        ))}
        {rows.length === 0 ? <p className="empty">Nothing matches.</p> : null}
      </div>
    </div>
  )
}

/** The description, with any looked-up-and-highlighted span marked in place. */
function Highlighted({ text, quotes }: { text: string; quotes: string[] }) {
  if (quotes.length === 0) return <p className="prose">{text}</p>
  // Longest first, so a quote containing another does not get carved up.
  const ordered = [...quotes].sort((a, b) => b.length - a.length)
  const parts: Array<string | { hit: string }> = [text]
  for (const quote of ordered) {
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (typeof part !== 'string') continue
      const at = part.indexOf(quote)
      if (at < 0) continue
      parts.splice(index, 1, part.slice(0, at), { hit: quote }, part.slice(at + quote.length))
    }
  }
  return (
    <p className="prose">
      {parts.map((part, index) =>
        typeof part === 'string' ? part : <mark key={index}>{part.hit}</mark>,
      )}
    </p>
  )
}

function Sheet() {
  const openId = useConsoleStore((state) => state.openSubmissionId)
  const spans = useConsoleStore((state) => state.foundSpans)
  const highlighted = useConsoleStore((state) => state.highlightedSpanIds)
  const scores = useConsoleStore((state) => state.scores)
  const lastAgentAt = useConsoleStore((state) => state.lastAgentAt)
  const shortlist = useConsoleStore((state) => state.shortlist)
  const addNote = useConsoleStore((state) => state.addNote)
  const flag = useConsoleStore((state) => state.flag)

  if (!openId) {
    return (
      <div className="column">
        <p className="empty">Pick a submission, or let an agent open one.</p>
      </div>
    )
  }

  const submission = catalogById.get(openId)!
  const facts = appFactsById.get(openId)!
  const injected = injectionFindings(openId)
  const quotes = spans
    .filter((span) => span.submissionId === openId && highlighted.includes(span.spanId))
    .map((span) => span.quote)
  const recorded = scores[openId] ?? {}

  return (
    <div className="column">
      {/* Keyed on the last agent write so the sheet flashes when one lands. */}
      <div className="sheet flash" key={lastAgentAt ?? 'static'}>
        <h2>{submission.title}</h2>
        <p className="byline">
          <span className="mono">{submission.id}</span> · {submission.team} · {submission.track}
        </p>

        <Highlighted text={submission.description} quotes={quotes} />

        {injected.length > 0 ? (
          <p className="verdict fail">
            A scan of this description found {injected.length} instruction aimed at the reviewer.
          </p>
        ) : null}

        <table className="facts">
          <tbody>
            <tr>
              <th scope="row">Declared</th>
              <td>{submission.declaredStack.join(', ')}</td>
            </tr>
            <tr>
              <th scope="row">Detected in repo</th>
              <td>
                {facts.actualStack.join(', ')}
                {submission.declaredStack.some((entry) => !facts.actualStack.includes(entry)) ? (
                  <div className="verdict fail">declares more than the repository contains</div>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">Repository</th>
              <td className="mono">{repoFiles(openId).join('  ')}</td>
            </tr>
            <tr>
              <th scope="row">Demo</th>
              <td>{submission.demoUrl ?? <span className="verdict fail">not submitted</span>}</td>
            </tr>
            <tr>
              <th scope="row">Eligibility</th>
              <td>
                {eligibilityVerdicts(openId).map((entry) => (
                  <div key={entry.rule} className={`verdict ${entry.passed ? 'pass' : 'fail'}`}>
                    {entry.passed ? '✓' : '✗'} {entry.rule}
                  </div>
                ))}
              </td>
            </tr>
          </tbody>
        </table>

        <span className="eyebrow">Scores recorded here</span>
        {CRITERIA.map((criterion) => (
          <div key={criterion} className="scorerow">
            <span className="name">{criterion}</span>
            <span className={`scorebox${recorded[criterion] === undefined ? '' : ' is-set'}`}>
              {recorded[criterion] ?? '—'}
            </span>
          </div>
        ))}

        <details style={{ marginTop: 'var(--sp-4)' }}>
          <summary className="eyebrow" style={{ cursor: 'pointer' }}>
            README
          </summary>
          <pre className="readme">{submission.readme}</pre>
        </details>

        <div className="actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => shortlist(openId, submission.track as Track, 'human')}
          >
            Shortlist for {submission.track}
          </button>
          <button type="button" className="btn" onClick={() => addNote(openId, 'Needs a second opinion.', 'human')}>
            Note for a human
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => flag(openId, 'Flagged by the reviewer', 'human')}
          >
            Flag
          </button>
        </div>
      </div>
    </div>
  )
}

function Rail() {
  const shortlists = useConsoleStore((state) => state.shortlists)
  const notes = useConsoleStore((state) => state.notes)
  const flags = useConsoleStore((state) => state.flags)
  const log = useConsoleStore((state) => state.actionLog)

  return (
    <div className="column">
      <div className="rail-block">
        <span className="eyebrow">Shortlist</span>
        {Object.entries(shortlists).filter(([, ids]) => (ids ?? []).length > 0).length === 0 ? (
          <p className="empty">Nothing shortlisted yet.</p>
        ) : (
          Object.entries(shortlists).map(([track, ids]) =>
            (ids ?? []).length === 0 ? null : (
              <div key={track} style={{ marginBottom: 'var(--sp-2)' }}>
                <span className="eyebrow">{track}</span>
                <ul className="rail-list">
                  {(ids ?? []).map((id) => (
                    <li key={id}>
                      <span className="mono">{id}</span> {catalogById.get(id)?.title}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )
        )}
      </div>

      {flags.length > 0 ? (
        <div className="rail-block">
          <span className="eyebrow">Flagged</span>
          <ul className="rail-list">
            {flags.map((entry) => (
              <li key={`${entry.submissionId}-${entry.at}`}>
                <span className="mono">{entry.submissionId}</span> {entry.reason}{' '}
                <span className={`who ${entry.source}`}>{entry.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {notes.length > 0 ? (
        <div className="rail-block">
          <span className="eyebrow">Notes</span>
          <ul className="rail-list">
            {notes.map((entry) => (
              <li key={`${entry.submissionId}-${entry.at}`}>
                <span className="mono">{entry.submissionId}</span> {entry.note}{' '}
                <span className={`who ${entry.source}`}>{entry.source}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rail-block">
        <span className="eyebrow">Activity</span>
        {log.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <ul className="activity">
            {log.map((entry) => (
              <li
                key={`${entry.at}-${entry.tool}`}
                className={`${entry.source === 'agent' ? 'agent' : ''}${entry.failed ? ' failed' : ''}`}
              >
                {entry.summary}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default function App({ status }: { status: WebMcpStatus }) {
  return (
    <div className="console">
      <Masthead status={status} />
      <div className="desk">
        <SubmissionList />
        <Sheet />
        <Rail />
      </div>
    </div>
  )
}
