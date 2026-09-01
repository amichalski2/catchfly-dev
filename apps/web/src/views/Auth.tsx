import { useState } from 'react';

import '../styles/signin.css';
import { WORKSPACE_PATH } from './Landing.tsx';
import { rememberSession, supabase } from '../data/supabase.ts';

type Mode = 'sign-in' | 'sign-up' | 'confirm' | 'reset';

const POINTS = [
  {
    icon: '/signin/compare.webp',
    title: 'Track and compare',
    body: 'See what agents did across tools, models and repo versions.',
  },
  {
    icon: '/signin/find.webp',
    title: 'Find what matters',
    body: 'Detect regressions, surface root causes, and speed up debugging.',
  },
  {
    icon: '/signin/ship.webp',
    title: 'Ship with confidence',
    body: 'Catch issues early and keep quality high, every release.',
  },
];

function MailIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <rect x="2.5" y="4.5" width="15" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="m3 6 7 5 7-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <rect x="4" y="8.5" width="12" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 8.5V6.6a3 3 0 0 1 6 0v1.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M1.8 10S4.9 4.8 10 4.8 18.2 10 18.2 10 15.1 15.2 10 15.2 1.8 10 1.8 10Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.3" />
      {off ? <path d="m3.5 16.5 13-13" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /> : null}
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10.1 10.1 0 0 1-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3Z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7A22 22 0 0 0 24 46Z"
      />
      <path fill="#FBBC05" d="M11.8 28.2a13.2 13.2 0 0 1 0-8.4v-5.7H4.5a22 22 0 0 0 0 19.8l7.3-5.7Z" />
      <path
        fill="#EA4335"
        d="M24 9.5c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3A22 22 0 0 0 4.5 14.1l7.3 5.7c1.7-5.2 6.5-9 12.2-9Z"
      />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeOpacity="0.45" />
      <path
        d="M8.5 6.5 12 10l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Aside() {
  return (
    <aside className="signin-aside">
      <h2>
        Understand your
        <br />
        agents&rsquo; impact
      </h2>
      <p>Catchfly helps you uncover what changed, why it changed, and how to make it better.</p>
      <ul className="signin-points">
        {POINTS.map((point) => (
          <li key={point.title}>
            <img src={point.icon} alt="" aria-hidden="true" width={44} height={44} />
            <div>
              <strong>{point.title}</strong>
              <p>{point.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="signin">
      <div className="signin-decor" aria-hidden="true">
        <img
          src="/brand/landing/landing-bg.webp"
          srcSet="/brand/landing/landing-bg@1x.webp 1280w, /brand/landing/landing-bg.webp 2560w"
          sizes="100vw"
          alt=""
          width={2560}
          height={1428}
          loading="eager"
          fetchPriority="high"
        />
      </div>
      <section className="signin-card">{children}</section>
    </div>
  );
}

export function Auth() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [peek, setPeek] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  if (!supabase) {
    return (
      <Shell>
        <div className="signin-form">
          <img src="/brand/catchfly-mark.png" alt="" aria-hidden="true" className="signin-mark" />
          <h1>Accounts are not configured</h1>
          <p className="signin-lede">
            Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (and CATCHFLY_AUTH_MODE=supabase on the
            server) to enable sign-in, or run with CATCHFLY_AUTH_MODE=none for an open self-hosted
            dashboard.
          </p>
          <a className="signin-oauth" href={WORKSPACE_PATH}>
            Explore the demo instead
          </a>
        </div>
        <Aside />
      </Shell>
    );
  }

  const client = supabase;

  async function run(action: () => Promise<void>): Promise<void> {
    setWorking(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }

  const submit = () =>
    run(async () => {
      rememberSession(remember);
      if (mode === 'sign-up') {
        const { data, error: cause } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}${WORKSPACE_PATH}` },
        });
        if (cause) throw cause;
        if (data.session) {
          window.location.replace(WORKSPACE_PATH);
          return;
        }
        setMode('confirm');
        return;
      }
      const { error: cause } = await client.auth.signInWithPassword({ email, password });
      if (cause) throw cause;
      window.location.replace(WORKSPACE_PATH);
    });

  const google = () =>
    run(async () => {
      rememberSession(remember);
      const { error: cause } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: `${window.location.origin}${WORKSPACE_PATH}` },
      });
      if (cause) throw cause;
    });

  const forgot = () =>
    run(async () => {
      if (!email) throw new Error('Enter your email address first, then ask for a reset link.');
      const { error: cause } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}${WORKSPACE_PATH}?signin`,
      });
      if (cause) throw cause;
      setMode('reset');
    });

  if (mode === 'confirm' || mode === 'reset') {
    return (
      <Shell>
        <div className="signin-form">
          <img src="/brand/catchfly-mark.png" alt="" aria-hidden="true" className="signin-mark" />
          <h1>Check your inbox</h1>
          <p className="signin-lede">
            {mode === 'confirm' ? 'We sent a confirmation link to ' : 'We sent a password reset link to '}
            <strong>{email}</strong>. Open it, then sign in here.
          </p>
          <button type="button" className="signin-oauth" onClick={() => setMode('sign-in')}>
            Back to sign in
          </button>
        </div>
        <Aside />
      </Shell>
    );
  }

  const signUp = mode === 'sign-up';
  return (
    <Shell>
      <form
        className="signin-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <img src="/brand/catchfly-mark.png" alt="" aria-hidden="true" className="signin-mark" />
        <h1>{signUp ? 'Create your account' : 'Welcome back'}</h1>
        <p className="signin-lede">
          {signUp ? 'Start free — your first project is created for you.' : 'Sign in to continue with Catchfly.'}
        </p>

        <label className="signin-field">
          <span>Email address</span>
          <div className="signin-control">
            <MailIcon />
            <input
              autoFocus
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
        </label>

        <label className="signin-field">
          <span>Password</span>
          <div className="signin-control">
            <LockIcon />
            <input
              type={peek ? 'text' : 'password'}
              autoComplete={signUp ? 'new-password' : 'current-password'}
              placeholder="Enter your password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              type="button"
              className="signin-peek"
              aria-label={peek ? 'Hide password' : 'Show password'}
              onClick={() => setPeek(!peek)}
            >
              <EyeIcon off={peek} />
            </button>
          </div>
        </label>

        <div className="signin-row">
          <label className="signin-remember">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            Remember me
          </label>
          {signUp ? null : (
            <button type="button" className="signin-link" onClick={() => void forgot()}>
              Forgot password?
            </button>
          )}
        </div>

        {error ? <p className="signin-error">{error}</p> : null}

        <button
          type="submit"
          className="signin-submit"
          disabled={!email || password.length < 8 || working}
        >
          {working ? 'Working…' : signUp ? 'Create account' : 'Sign in'}
          <ArrowIcon />
        </button>

        <p className="signin-or">
          <span>or</span>
        </p>

        <button type="button" className="signin-oauth" disabled={working} onClick={() => void google()}>
          <GoogleIcon />
          Continue with Google
        </button>

        <p className="signin-foot">
          {signUp ? 'Already have an account?' : "Don't have an account?"}{' '}
          <button type="button" className="signin-link" onClick={() => setMode(signUp ? 'sign-in' : 'sign-up')}>
            {signUp ? 'Sign in' : 'Sign up'}
          </button>
          {' · '}
          <a className="signin-link" href={WORKSPACE_PATH}>
            Explore the demo
          </a>
        </p>
      </form>
      <Aside />
    </Shell>
  );
}
