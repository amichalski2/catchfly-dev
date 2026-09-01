import { lazy, Suspense } from 'react';

import { Shell } from './components/Shell.tsx';
import { getDb } from '@catchfly/core/db.ts';
import { useCatchflyStore } from './state/store.ts';
import { Overview } from './views/Overview.tsx';
import { Onboarding } from './views/Onboarding.tsx';
import { OnboardingWizard } from './views/OnboardingWizard.tsx';
import { Profile } from './views/Profile.tsx';
import { Auth } from './views/Auth.tsx';

/**
 * Overview is what a boot lands on, so it ships with the first chunk. Every
 * other view is a navigation away and costs nothing to defer — loading them all
 * up front is what made the bundle a single 400 kB file.
 */
const CaseDetail = lazy(() => import('./views/CaseDetail.tsx').then((m) => ({ default: m.CaseDetail })));
const Cases = lazy(() => import('./views/Cases.tsx').then((m) => ({ default: m.Cases })));
const Regressions = lazy(() => import('./views/Regressions.tsx').then((m) => ({ default: m.Regressions })));
const ReleaseComparison = lazy(() =>
  import('./views/ReleaseComparison.tsx').then((m) => ({ default: m.ReleaseComparison })),
);
const SessionDetail = lazy(() => import('./views/SessionDetail.tsx').then((m) => ({ default: m.SessionDetail })));
const Sessions = lazy(() => import('./views/Sessions.tsx').then((m) => ({ default: m.Sessions })));
const ToolProfile = lazy(() => import('./views/ToolProfile.tsx').then((m) => ({ default: m.ToolProfile })));
const Settings = lazy(() => import('./views/Settings.tsx').then((m) => ({ default: m.Settings })));
const Sources = lazy(() => import('./views/Sources.tsx').then((m) => ({ default: m.Sources })));
const System = lazy(() => import('./views/System.tsx').then((m) => ({ default: m.System })));

const SETTINGS_VIEWS = ['sources', 'settings', 'system', 'profile'] as const;

const TITLES = {
  overview: { title: 'Overview', subtitle: 'How the candidate compares to what is in production.' },
  releases: { title: 'Releases', subtitle: 'Two releases of the deployed app, side by side in production.' },
  regressions: { title: 'Regression Explorer', subtitle: 'What broke, ignoring what was already broken.' },
  cases: { title: 'Cases', subtitle: 'Every eval case, filterable.' },
  'case-detail': { title: 'Case detail', subtitle: 'One case, across runs.' },
  sessions: { title: 'Sessions', subtitle: 'What agents did on the deployed app.' },
  sources: { title: 'Project settings', subtitle: 'Connect telemetry, manage environments and control how project data is handled.' },
  settings: { title: 'Project settings', subtitle: 'Connect telemetry, manage environments and control how project data is handled.' },
  system: { title: 'Project settings', subtitle: 'Connect telemetry, manage environments and control how project data is handled.' },
  profile: { title: 'Project settings', subtitle: 'Connect telemetry, manage environments and control how project data is handled.' },
  'session-detail': { title: 'Session', subtitle: 'One production trace, call by call.' },
  'tool-profile': { title: 'Tool profile', subtitle: 'One tool, in production and in the suite.' },
} as const;

export default function App() {
  const ready = useCatchflyStore((state) => state.ready);
  const loadError = useCatchflyStore((state) => state.loadError);
  const isEmpty = useCatchflyStore((state) => state.isEmpty);
  const authRequired = useCatchflyStore((state) => state.authRequired);
  const view = useCatchflyStore((state) => state.view);
  const setView = useCatchflyStore((state) => state.setView);
  const account = useCatchflyStore((state) => state.account);

  if (authRequired) return <Auth />;

  if (loadError) {
    return (
      <div className="boot">
        <h1>Catchfly</h1>
        <p className="boot-error">Could not load the eval dataset: {loadError}</p>
        <p className="muted">Reload the page. If this keeps happening, the dataset failed to download.</p>
      </div>
    );
  }

  // A working deployment that holds nothing yet. Not an error, and not a
  // spinner that never resolves: say what is missing and how to fix it.
  if (isEmpty) {
    if (account) return <OnboardingWizard />;
    return <Onboarding />;
  }

  if (!ready) {
    return (
      <div className="boot">
        <h1>Catchfly</h1>
        <p className="boot-loading muted">
          <img
            className="boot-loading-flower"
            src="/brand/mark-regressed.webp"
            alt=""
            width="20"
            height="20"
            aria-hidden="true"
          />
          Loading eval data…
        </p>
      </div>
    );
  }

  const { title: defaultTitle, subtitle: defaultSubtitle } = TITLES[view];
  const isInvestigationOverview =
    view === 'overview' && getDb().dataset.project.generatorVersion?.startsWith('scale-world');
  const title = isInvestigationOverview ? 'Incidents' : defaultTitle;
  const subtitle = isInvestigationOverview
    ? 'Incidents corroborated across evals and production traffic.'
    : defaultSubtitle;
  const isSettingsView = SETTINGS_VIEWS.some((settingsView) => settingsView === view);

  return (
    <Shell title={title} subtitle={subtitle}>
      {isSettingsView ? (
        <nav className="settings-tabs" aria-label="Project settings sections">
          <button
            type="button"
            className={view === 'sources' ? 'is-active' : ''}
            aria-current={view === 'sources' ? 'page' : undefined}
            onClick={() => setView('sources', 'human')}
          >
            Connection
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'is-active' : ''}
            aria-current={view === 'settings' ? 'page' : undefined}
            onClick={() => setView('settings', 'human')}
          >
            Data policy
          </button>
          <button
            type="button"
            className={view === 'system' ? 'is-active' : ''}
            aria-current={view === 'system' ? 'page' : undefined}
            onClick={() => setView('system', 'human')}
          >
            System
          </button>
          {account ? (
            <button
              type="button"
              className={view === 'profile' ? 'is-active' : ''}
              aria-current={view === 'profile' ? 'page' : undefined}
              onClick={() => setView('profile', 'human')}
            >
              Profile
            </button>
          ) : null}
        </nav>
      ) : null}
      <Suspense fallback={<p className="muted">Loading view…</p>}>
        {view === 'overview' ? <Overview /> : null}
        {view === 'releases' ? <ReleaseComparison /> : null}
        {view === 'regressions' ? <Regressions /> : null}
        {view === 'cases' ? <Cases /> : null}
        {view === 'case-detail' ? <CaseDetail /> : null}
        {view === 'sessions' ? <Sessions /> : null}
        {view === 'sources' ? <Sources /> : null}
        {view === 'settings' ? <Settings /> : null}
        {view === 'system' ? <System /> : null}
        {view === 'profile' ? <Profile /> : null}
        {view === 'session-detail' ? <SessionDetail /> : null}
        {view === 'tool-profile' ? <ToolProfile /> : null}
      </Suspense>
    </Shell>
  );
}
