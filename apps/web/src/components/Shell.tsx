/**
 * Application shell: brand, navigation, session strip, view slot.
 *
 * The rail is icon-only, so every entry carries its name in `title` and
 * `aria-label` — the picture is the affordance, the label is still the
 * accessible name.
 *
 * Navigation writes through the same store action the agent's set_dashboard_filters
 * tool uses, with source 'human' — there is deliberately no second path.
 */

import type { ReactNode } from 'react';

import { switchProject } from '../data/load.ts';
import { listProjectInfo, projectInfo } from '../data/projects.ts';
import { supabase } from '../data/supabase.ts';
import { useCatchflyStore, type ViewName } from '../state/store.ts';
import { AgentActivity } from './AgentActivity.tsx';
import { Botanical } from './Botanical.tsx';
import { SessionStrip } from './SessionStrip.tsx';

const NAV: Array<{ view: ViewName; label: string; icon: string }> = [
  { view: 'overview', label: 'Incidents', icon: '/nav/overview.svg' },
  { view: 'releases', label: 'Releases', icon: '/nav/releases.svg' },
  { view: 'regressions', label: 'Regression Explorer', icon: '/nav/regression.svg' },
  { view: 'sessions', label: 'Sessions', icon: '/nav/sessions.svg' },
  { view: 'cases', label: 'Cases', icon: '/nav/cases.svg' },
];

const SETTINGS_VIEWS: ViewName[] = ['sources', 'settings', 'system'];

/** Detail views have no nav entry of their own; each lights up its parent. */
const PARENT: Partial<Record<ViewName, ViewName>> = {
  'case-detail': 'cases',
  'session-detail': 'sessions',
  'tool-profile': 'sessions',
};

export function Shell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const view = useCatchflyStore((state) => state.view);
  const setView = useCatchflyStore((state) => state.setView);
  const projectId = useCatchflyStore((state) => state.projectId);
  const account = useCatchflyStore((state) => state.account);
  const activeProject = projectInfo(projectId);
  const projects = listProjectInfo();

  return (
    <div className="shell">
      <aside className="sidebar">
        <img className="brand-mark" src="/brand/catchfly-mark.png" alt="Catchfly" />
        <nav className="sidebar-primary" aria-label="Product">
          {NAV.map((item) => (
            <button
              key={item.view}
              type="button"
              className={`nav-item${view === item.view || PARENT[view] === item.view ? ' is-active' : ''}`}
              title={item.label}
              aria-label={item.label}
              aria-current={view === item.view || PARENT[view] === item.view ? 'page' : undefined}
              onClick={() => setView(item.view, 'human')}
            >
              <img src={item.icon} alt="" aria-hidden="true" />
            </button>
          ))}
        </nav>
        <nav className="sidebar-utility" aria-label="Configuration">
          <button
            type="button"
            className={`nav-item${SETTINGS_VIEWS.includes(view) ? ' is-active' : ''}`}
            title="Project settings"
            aria-label="Project settings"
            aria-current={SETTINGS_VIEWS.includes(view) ? 'page' : undefined}
            onClick={() => {
              if (!SETTINGS_VIEWS.includes(view)) setView('sources', 'human');
            }}
          >
            <img src="/nav/settingsicon.svg" alt="" aria-hidden="true" />
          </button>
        </nav>
      </aside>

      <div className="main">
        <Botanical />
        <header className="main-head">
          <div>
            <h1>{title}</h1>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          {/* The rail has no room for it, and it is state the reader needs on
              every view — so it sits with the page title instead. */}
          <div className="project-switch">
            <span className="eyebrow">Project</span>
            {projects.length > 1 ? (
              <select
                value={projectId}
                onChange={(event) => void switchProject(event.target.value, 'human')}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id} title={project.description}>
                    {project.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong title={activeProject?.description}>
                {activeProject?.name ?? 'Devpost Review Console'}
              </strong>
            )}
            {activeProject?.dataOrigin ? (
              <span className="project-origin">
                {activeProject.dataOrigin === 'synthetic'
                  ? account
                    ? 'Preview · synthetic demo data'
                    : 'Synthetic demo data'
                  : activeProject.dataOrigin === 'mixed'
                    ? 'Measured evals · synthetic traffic'
                    : 'Measured data'}
              </span>
            ) : null}
            {account ? (
              <button
                type="button"
                className="linkish shell-signout"
                title={account.email}
                onClick={() => void supabase?.auth.signOut()}
              >
                Sign out
              </button>
            ) : null}
          </div>
        </header>
        <SessionStrip />
        <AgentActivity />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
