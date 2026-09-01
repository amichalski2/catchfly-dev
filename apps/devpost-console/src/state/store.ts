/**
 * The console's shared state — shared in the same sense Catchfly's is: a human
 * clicking and an agent calling a tool write through the same actions, and the
 * screen shows what either of them did.
 *
 * Simpler than Catchfly's store: no undo, no URL projection. What it does keep
 * is attribution, because the demo's whole claim is that you can watch an agent
 * work, and a shortlist that appeared without saying who added it is exactly
 * the thing that makes people distrust agentic software.
 *
 * Note what is NOT here: the backend's own memory. `SessionState` in the world
 * package tracks which evidence spans have been looked up and what has been
 * scored, because those are contract facts; this store tracks what to draw.
 */

import type { Track } from '@catchfly/devpost-world/catalog.ts'
import { create } from 'zustand'

export type ActionSource = 'human' | 'agent'

export type ActionRecord = {
  tool: string
  source: ActionSource
  summary: string
  at: number
  failed?: boolean
}

export type FoundSpan = {
  spanId: string
  submissionId: string
  quote: string
  source: string
}

export type Note = { submissionId: string; note: string; source: ActionSource; at: number }
export type Flag = { submissionId: string; reason: string; source: ActionSource; at: number }

type State = {
  version: string
  track: Track | null
  query: string
  openSubmissionId: string | null
  /** Spans a lookup has returned, so the UI can show what is highlightable. */
  foundSpans: FoundSpan[]
  highlightedSpanIds: string[]
  shortlists: Partial<Record<Track, string[]>>
  notes: Note[]
  flags: Flag[]
  /** Scores recorded on this page, mirrored for display. */
  scores: Record<string, Partial<Record<string, number>>>
  actionLog: ActionRecord[]
  /** Timestamp of the last agent write, so panels can flash. */
  lastAgentAt: number | null
}

type Actions = {
  setVersion: (version: string) => void
  setTrack: (track: Track | null, source?: ActionSource) => void
  setQuery: (query: string, source?: ActionSource) => void
  openSubmission: (submissionId: string, source?: ActionSource) => void
  closeSubmission: () => void
  noteSpans: (spans: FoundSpan[], source?: ActionSource) => void
  highlightSpan: (spanId: string, source?: ActionSource) => void
  shortlist: (submissionId: string, track: Track, source?: ActionSource) => void
  addNote: (submissionId: string, note: string, source?: ActionSource) => void
  flag: (submissionId: string, reason: string, source?: ActionSource) => void
  recordScore: (submissionId: string, criterion: string, score: number, source?: ActionSource) => void
  logCall: (tool: string, summary: string, source: ActionSource, failed?: boolean) => void
}

const LOG_LIMIT = 40

export const useConsoleStore = create<State & Actions>((set) => {
  /** Every mutation goes through here, so nothing lands unattributed. */
  const log = (tool: string, source: ActionSource, summary: string, failed = false) =>
    set((state) => ({
      actionLog: [{ tool, source, summary, at: Date.now(), failed }, ...state.actionLog].slice(0, LOG_LIMIT),
      lastAgentAt: source === 'agent' ? Date.now() : state.lastAgentAt,
    }))

  return {
    version: 'console-v3',
    track: null,
    query: '',
    openSubmissionId: null,
    foundSpans: [],
    highlightedSpanIds: [],
    shortlists: {},
    notes: [],
    flags: [],
    scores: {},
    actionLog: [],
    lastAgentAt: null,

    setVersion: (version) => set({ version }),

    setTrack: (track, source = 'human') => {
      set({ track })
      log('set_track', source, track ? `Filtered to ${track}` : 'Cleared the track filter')
    },

    setQuery: (query, source = 'human') => set({ query, ...(source === 'agent' ? { lastAgentAt: Date.now() } : {}) }),

    openSubmission: (submissionId, source = 'human') => {
      set({ openSubmissionId: submissionId })
      log('open_submission', source, `Opened ${submissionId}`)
    },

    closeSubmission: () => set({ openSubmissionId: null }),

    noteSpans: (spans, source = 'agent') => {
      set((state) => {
        const held = new Set(state.foundSpans.map((span) => span.spanId))
        return { foundSpans: [...state.foundSpans, ...spans.filter((span) => !held.has(span.spanId))] }
      })
      if (source === 'agent') set({ lastAgentAt: Date.now() })
    },

    highlightSpan: (spanId, source = 'human') => {
      set((state) =>
        state.highlightedSpanIds.includes(spanId)
          ? state
          : { highlightedSpanIds: [...state.highlightedSpanIds, spanId] },
      )
      log('highlight_evidence', source, `Highlighted ${spanId}`)
    },

    shortlist: (submissionId, track, source = 'human') => {
      set((state) => {
        const current = state.shortlists[track] ?? []
        return current.includes(submissionId)
          ? state
          : { shortlists: { ...state.shortlists, [track]: [...current, submissionId] } }
      })
      log('build_shortlist', source, `Shortlisted ${submissionId} for ${track}`)
    },

    addNote: (submissionId, note, source = 'human') => {
      set((state) => ({ notes: [{ submissionId, note, source, at: Date.now() }, ...state.notes] }))
      log('add_review_note', source, `Noted on ${submissionId}`)
    },

    flag: (submissionId, reason, source = 'human') => {
      set((state) => ({ flags: [{ submissionId, reason, source, at: Date.now() }, ...state.flags] }))
      log('flag_submission', source, `Flagged ${submissionId}`)
    },

    recordScore: (submissionId, criterion, score, source = 'human') => {
      set((state) => ({
        scores: { ...state.scores, [submissionId]: { ...state.scores[submissionId], [criterion]: score } },
      }))
      log('score_submission', source, `${submissionId} · ${criterion} = ${score}`)
    },

    logCall: (tool, summary, source, failed) => log(tool, source, summary, failed),
  }
})

/** Store access from outside React — this is how the tool executors reach it. */
export const consoleStore = {
  getState: useConsoleStore.getState,
  setState: useConsoleStore.setState,
  subscribe: useConsoleStore.subscribe,
}
