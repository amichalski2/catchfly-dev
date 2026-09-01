import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { Landing, WORKSPACE_PATH } from './views/Landing.tsx';
import { setAnalysisUnavailable } from '@catchfly/core/analysis-db.ts';
import { fetchAccount, fetchProjects } from './data/api.ts';
import { defaultComparison, loadDb } from './data/load.ts';
import { defaultProjectId, projectInfo, setProjects } from './data/projects.ts';
import { connectSessions } from './data/sessions-remote.ts';
import { supabase } from './data/supabase.ts';
import { useCatchflyStore } from './state/store.ts';
import { applyHash, projectFromHash, startUrlSync } from './state/urlSync.ts';
import { initLandingWebMcp, initWebMcp } from './webmcp/index.ts';
import './styles/base.css';
import './styles/product.css';
import './styles/collab.css';

const root = createRoot(document.getElementById('root')!);

/**
 * The console lives under an opaque workspace path; everything else is the
 * public page. The split is on the pathname because the app's own routing is
 * in the hash, and the two must not fight over the same segment.
 */
const isWorkspace = window.location.pathname.startsWith(WORKSPACE_PATH);

root.render(<StrictMode>{isWorkspace ? <App /> : <Landing />}</StrictMode>);

/**
 * Boot: fetch the project registry, resolve which one this URL names, load it,
 * then hand the app its default comparison.
 */
async function boot(): Promise<void> {
  const session = supabase ? (await supabase.auth.getSession()).data.session : null;
  const wantsSignIn = new URLSearchParams(window.location.search).has('signin');
  if (supabase && !session && wantsSignIn) {
    useCatchflyStore.getState().requireAuth();
    return;
  }
  supabase?.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.replace(WORKSPACE_PATH);
  });

  startUrlSync();
  initWebMcp((status) => {
    useCatchflyStore.getState().setWebMcpStatus(status);
    console.info(
      status === 'active'
        ? 'WebMCP: site tools registered.'
        : 'WebMCP is not available in this browser; the UI works without it.',
    );
  });

  // No generated analysis endpoint is part of this build. Settle the registry
  // as unavailable so tools return deterministic evidence instead of waiting.
  setAnalysisUnavailable();

  if (session) {
    const account = await fetchAccount();
    const org = account.orgs[0] ?? null;
    useCatchflyStore.getState().setAccount({
      userId: account.user.id,
      email: account.user.email,
      orgId: org?.id ?? null,
      orgName: org?.name ?? null,
    });
    // The user's own projects lead; the synthetic demo stays reachable as a preview.
    setProjects(
      [...account.projects].sort(
        (a, b) => Number(a.dataOrigin === 'synthetic') - Number(b.dataOrigin === 'synthetic'),
      ),
    );
    if (!account.projects.some((project) => project.dataOrigin !== 'synthetic')) {
      useCatchflyStore.getState().markEmpty();
      return;
    }
  } else {
    setProjects(await fetchProjects());
  }

  // Nothing to load is a state, not a failure: a fresh install has no projects
  // until someone creates one.
  const fallback = defaultProjectId();
  if (!fallback) {
    useCatchflyStore.getState().markEmpty();
    return;
  }

  // A shared link may name a project; boot into the one it names.
  const named = projectFromHash();
  if (named && !projectInfo(named)) {
    if (supabase && !session) {
      useCatchflyStore.getState().requireAuth();
      return;
    }
    console.warn(`No project "${named}" — opening ${fallback} instead.`);
  }
  const projectId = named && projectInfo(named) ? named : fallback;

  const db = await loadDb(projectId);

  // Point the session layer at this project. It settles as unavailable on its
  // own if the deployment has no database, so nothing below has to ask.
  connectSessions(projectId);

  useCatchflyStore.getState().markReady(defaultComparison(db), projectId);

  // Only now can a shared link's view — and especially its case id — be
  // resolved: both need the dataset the link names to be loaded.
  applyHash();
}

if (isWorkspace) {
  boot().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Catchfly failed to start', error);
    useCatchflyStore.getState().failToLoad(message);
  });
} else {
  // Keep the public page cheap: expose only the hand-off tool. Its navigation
  // is deferred one task so the browser can receive the tool result before the
  // document unloads; the workspace registers the full analytics surface.
  initLandingWebMcp(
    () => window.setTimeout(() => window.location.assign(WORKSPACE_PATH), 0),
    (status) => {
      console.info(
        status === 'active'
          ? 'WebMCP: landing hand-off tool registered.'
          : 'WebMCP is not available in this browser; the landing page works without it.',
      );
    },
  );
}
