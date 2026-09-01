/**
 * The console's WebMCP surface.
 *
 * Every tool is the manifest entry for the served version — its name,
 * description and input schema, verbatim — zipped with one executor: the
 * world's `execute()`. That is the whole design. The manifest decides what an
 * agent is *told*; the backend decides what actually happens; and because both
 * come from the same package the generated demo sessions describe, this app and
 * the seeded history cannot drift apart.
 *
 * Serving v2 therefore needs no special code. v2 is simply a manifest whose
 * descriptions say less, pointed at a backend that enforces exactly as much as
 * it always did.
 *
 * Six tools additionally move the screen, so a person watching can see the
 * agent work. Those write through the same store actions the UI's own buttons
 * call, tagged 'agent'.
 */

import { newSessionState, execute } from '@catchfly/devpost-world/results.ts'
import type { Track } from '@catchfly/devpost-world/catalog.ts'
import { manifestFor } from '@catchfly/devpost-world/tools.ts'
import { registerToolGroup } from '@catchfly/webmcp/registry.ts'
import type { ModelContext, ModelContextTool, WebMcpStatus } from '@catchfly/webmcp/spec.ts'

import { consoleStore } from '../state/store.ts'

declare global {
  interface Document {
    readonly modelContext?: ModelContext
  }
}

export type { WebMcpStatus }

/** How long to keep watching for a late-installed model context. */
const WATCH_WINDOW_MS = 10_000
const WATCH_INTERVAL_MS = 250

function getModelContext(): ModelContext | null {
  return typeof document.modelContext?.registerTool === 'function' ? document.modelContext : null
}

/**
 * One page visit, one backend memory. Which spans have been looked up and what
 * has been scored are facts about this visit, and the runner opens a fresh page
 * per case, so this resets exactly when it should.
 */
const pageState = newSessionState()

/** Mirrors an agent's call into the screen, where the tool is one people watch. */
function reflect(functionName: string, args: Record<string, unknown>, result: unknown): void {
  const store = consoleStore.getState()
  const submissionId = typeof args.submissionId === 'string' ? args.submissionId : null

  switch (functionName) {
    case 'open_submission':
      if (submissionId) store.openSubmission(submissionId, 'agent')
      break
    case 'find_evidence': {
      const spans = (result as { spans?: Array<{ spanId: string; quote: string; source: string }> }).spans ?? []
      if (submissionId) {
        store.noteSpans(spans.map((span) => ({ ...span, submissionId })), 'agent')
      }
      break
    }
    case 'highlight_evidence':
      if (typeof args.spanId === 'string') store.highlightSpan(args.spanId, 'agent')
      break
    case 'build_shortlist':
      if (submissionId && typeof args.track === 'string') {
        store.shortlist(submissionId, args.track as Track, 'agent')
      }
      break
    case 'add_review_note':
      if (submissionId && typeof args.note === 'string') store.addNote(submissionId, args.note, 'agent')
      break
    case 'flag_submission':
      if (submissionId && typeof args.reason === 'string') store.flag(submissionId, args.reason, 'agent')
      break
    case 'score_submission':
      if (submissionId && typeof args.criterion === 'string' && typeof args.score === 'number') {
        store.recordScore(submissionId, args.criterion, args.score, 'agent')
      }
      break
    default:
      // A read. Logged below like everything else, but it changes nothing.
      break
  }
}

const summarize = (functionName: string, args: Record<string, unknown>): string => {
  const parts = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
  return parts ? `${functionName}(${parts})` : `${functionName}()`
}

export function buildTools(versionId: string): ModelContextTool[] {
  return manifestFor(versionId).map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema ?? { type: 'object', properties: {} },
    execute: async (input: Record<string, unknown>) => {
      const args = input ?? {}
      const outcome = execute(schema.name, args, pageState)

      if (!outcome.ok) {
        consoleStore.getState().logCall(schema.name, `${summarize(schema.name, args)} — ${outcome.message}`, 'agent', true)
        // A refusal is a tool error, which is what the agent needs to see.
        throw new Error(outcome.message)
      }

      reflect(schema.name, args, outcome.value)
      // Writes log themselves through the store action; reads would otherwise
      // be invisible, and an activity strip that only shows writes tells half
      // the story of how the agent got there.
      const isWrite = [
        'open_submission',
        'find_evidence',
        'highlight_evidence',
        'build_shortlist',
        'add_review_note',
        'flag_submission',
        'score_submission',
      ].includes(schema.name)
      if (!isWrite) {
        consoleStore.getState().logCall(schema.name, summarize(schema.name, args), 'agent')
      }
      return outcome.value
    },
  }))
}

/**
 * Registers the surface, reporting status as it settles. Same watch-window
 * behaviour as Catchfly's own page: a browser that installs `modelContext`
 * after our scripts run must not be reported as unsupported forever.
 */
export function initWebMcp(versionId: string, onStatus: (status: WebMcpStatus) => void): void {
  const attach = (context: ModelContext) => registerToolGroup(context, buildTools(versionId))

  const immediate = getModelContext()
  if (immediate) {
    attach(immediate)
    onStatus('active')
    return
  }

  onStatus('unsupported')

  const deadline = Date.now() + WATCH_WINDOW_MS
  const timer = setInterval(() => {
    const context = getModelContext()
    if (context) {
      clearInterval(timer)
      attach(context)
      onStatus('active')
      return
    }
    if (Date.now() > deadline) clearInterval(timer)
  }, WATCH_INTERVAL_MS)
}
