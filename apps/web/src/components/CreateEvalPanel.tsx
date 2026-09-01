/**
 * Create an eval case from the session on screen.
 *
 * The panel is a review step, not a form. Catchfly has already worked out what
 * the case should say — the prompt from the captured intent, the expectation
 * from the calls that worked — and shows it so a person can correct it before
 * it becomes a test. Minting silently would be faster and worse: an expectation
 * nobody read is a test nobody trusts.
 *
 * Per-call checkboxes exist because a session usually contains a few calls that
 * were orientation rather than the task. Unchecking those is how the case stops
 * asserting them.
 */

import { useState } from 'react';

import { buildCaseFromSession, MintError } from '@catchfly/core/eval-from-session.ts';
import { getDb } from '@catchfly/core/db.ts';
import type { Session } from '@catchfly/core/session-types.ts';

import { ApiError, createCase, readStoredEvalKey, storeEvalKey } from '../data/api.ts';
import { invalidateProject } from '../data/load.ts';
import { useCatchflyStore } from '../state/store.ts';

type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; caseId: string };

export function CreateEvalPanel({ session }: { session: Session }) {
  const projectId = useCatchflyStore((state) => state.projectId);
  const noteImport = useCatchflyStore((state) => state.noteImport);
  const openCase = useCatchflyStore((state) => state.openCase);
  const readOnlyDemo = getDb().dataset.project.dataOrigin === 'synthetic' && Boolean(getDb().dataset.project.generatorVersion);

  const taken = getDb().dataset.cases.map((entry) => entry.caseId);
  // The proposal mirrors what the button will send — every call ticked — rather
  // than the bare derivation. The bare one refuses when the failing tool was
  // never called, which is a fact worth stating (see missingTool below) but not
  // a reason to withhold the form: choosing the right calls is what it is for.
  let proposed: ReturnType<typeof buildCaseFromSession> | null = null;
  let proposalError = '';
  try {
    proposed = buildCaseFromSession(session, {
      taken,
      correctedCalls: session.toolCalls.map((call) => ({
        functionName: call.toolName,
        arguments: call.status === 'success' ? (call.arguments ?? null) : null,
      })),
    });
  } catch (error) {
    proposalError = error instanceof MintError ? error.message : String(error);
  }

  const missingTool =
    session.failureTool && !session.toolCalls.some((call) => call.toolName === session.failureTool)
      ? session.failureTool
      : null;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(proposed?.name ?? '');
  const [prompt, setPrompt] = useState(proposed?.prompt ?? session.intent ?? '');
  const [behavior, setBehavior] = useState(proposed?.expectedBehavior ?? '');
  const [included, setIncluded] = useState<boolean[]>(() => session.toolCalls.map(() => true));
  const [strictArgs, setStrictArgs] = useState(true);
  const [key, setKey] = useState(readStoredEvalKey);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const chosen = session.toolCalls.filter((_, index) => included[index]);

  async function mint(): Promise<void> {
    setStatus({ kind: 'working' });
    try {
      const evalCase = buildCaseFromSession(session, {
        taken,
        name,
        prompt,
        expectedBehavior: behavior,
        correctedCalls: chosen.map((call) => ({
          functionName: call.toolName,
          // A call that was rejected never had usable arguments to assert, so
          // strict mode still leaves those open.
          arguments: strictArgs && call.status === 'success' ? (call.arguments ?? null) : null,
        })),
      });

      await createCase({ projectId, evalCase, key });
      storeEvalKey(key);
      // The server now holds a case the cached dataset does not.
      invalidateProject(projectId);
      noteImport(`Created eval case ${evalCase.caseId} from session ${session.id}`, 'human');
      setStatus({ kind: 'done', caseId: evalCase.caseId });
    } catch (error) {
      const message =
        error instanceof ApiError && error.status === 401
          ? 'That CI key was refused. Create a new one in Project settings → Connection.'
          : error instanceof Error
            ? error.message
            : String(error);
      setStatus({ kind: 'error', message });
    }
  }

  if (readOnlyDemo) {
    return <section className="panel"><div className="panel-head"><div><h2>Create eval from this session</h2><p className="muted">The synthetic investigation lab is read-only. Use a measured project to turn a production trace into an eval.</p></div></div></section>;
  }

  if (proposalError) {
    return (
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Create eval from this session</h2>
            <p className="muted">{proposalError}</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Create eval from this session</h2>
          {missingTool ? (
            <p className="mint-warning">
              This session failed by never calling <code>{missingTool}</code>. The calls below are
              the trajectory that went wrong, not the one to assert — add{' '}
              <code>{missingTool}</code> or untick what should not have run before saving.
            </p>
          ) : null}
          <p className="muted">
            Turn what happened here into a case that runs every time. Review the expectation first:
            it starts from the calls this session made, and a failed session is not a description of
            correct behaviour.
          </p>
        </div>
        {!open && status.kind !== 'done' ? (
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Create eval
          </button>
        ) : null}
      </div>

      {status.kind === 'done' ? (
        <div className="panel-body">
          <p className="import-done">
            Created <code>{status.caseId}</code>.{' '}
            <button type="button" className="linkish" onClick={() => openCase(status.caseId, 'human')}>
              Open the case
            </button>
          </p>
        </div>
      ) : null}

      {open && status.kind !== 'done' ? (
        <div className="panel-body">
          <label className="field field-grow">
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>

          <label className="field field-grow">
            <span>Prompt</span>
            <input
              value={prompt}
              placeholder="What was being asked for"
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>

          <label className="field field-grow">
            <span>Expected behaviour</span>
            <input value={behavior} onChange={(event) => setBehavior(event.target.value)} />
          </label>

          <table className="table table-dense">
            <thead>
              <tr>
                <th scope="col">Assert</th>
                <th scope="col">Tool</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {session.toolCalls.map((call, index) => (
                <tr key={`${call.toolName}-${index}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={included[index]}
                      aria-label={`Include ${call.toolName}`}
                      onChange={(event) =>
                        setIncluded((current) =>
                          current.map((value, at) => (at === index ? event.target.checked : value)),
                        )
                      }
                    />
                  </td>
                  <th scope="row">
                    <code>{call.toolName}</code>
                  </th>
                  <td>
                    <span className={`pill pill-${call.status === 'error' ? 'fail' : 'pass'}`}>
                      {call.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="field">
            <span>Arguments</span>
            <select
              value={strictArgs ? 'strict' : 'any'}
              onChange={(event) => setStrictArgs(event.target.value === 'strict')}
            >
              <option value="strict">Must match what worked</option>
              <option value="any">Any arguments</option>
            </select>
          </label>

          <label className="field field-grow">
            <span>Ingest key</span>
            <input
              type="password"
              value={key}
              placeholder="x-catchfly-key"
              onChange={(event) => setKey(event.target.value)}
            />
          </label>

          {status.kind === 'error' ? <p className="import-error">{status.message}</p> : null}

          <p className="table-foot">
            <button
              type="button"
              className="btn"
              disabled={status.kind === 'working' || chosen.length === 0 || prompt.trim() === ''}
              onClick={() => void mint()}
            >
              {status.kind === 'working' ? 'Creating…' : `Create case from ${chosen.length} calls`}
            </button>{' '}
            <button type="button" className="btn btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </p>
        </div>
      ) : null}
    </section>
  );
}
