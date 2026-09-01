import { useState } from 'react';

import { renameOrg } from '../data/api.ts';
import { supabase } from '../data/supabase.ts';
import { useCatchflyStore } from '../state/store.ts';

export function Profile() {
  const account = useCatchflyStore((state) => state.account);
  const setAccount = useCatchflyStore((state) => state.setAccount);
  const [password, setPassword] = useState('');
  const [orgName, setOrgName] = useState(account?.orgName ?? '');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'password' | 'org' | null>(null);

  if (!account) {
    return (
      <section className="panel">
        <div className="panel-body muted">
          Sign in to manage your profile. The demo workspace has no account attached.
        </div>
      </section>
    );
  }

  const changePassword = async (): Promise<void> => {
    if (!supabase) return;
    setBusy('password');
    setStatus('');
    setError('');
    const { error: cause } = await supabase.auth.updateUser({ password });
    setBusy(null);
    if (cause) {
      setError(cause.message);
      return;
    }
    setPassword('');
    setStatus('Password updated.');
  };

  const saveOrgName = async (): Promise<void> => {
    if (!account.orgId) return;
    setBusy('org');
    setStatus('');
    setError('');
    try {
      await renameOrg(account.orgId, orgName.trim());
      setAccount({ ...account, orgName: orgName.trim() });
      setStatus('Organization renamed.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Account</h2>
            <p className="muted">Who you are on this installation.</p>
          </div>
        </div>
        <div className="panel-body profile-grid">
          <label className="field">
            <span>Email</span>
            <input type="email" value={account.email} readOnly disabled />
          </label>
          <label className="field">
            <span>New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={password.length < 8 || busy !== null}
            onClick={() => void changePassword()}
          >
            {busy === 'password' ? 'Updating…' : 'Change password'}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Organization</h2>
            <p className="muted">The workspace your projects belong to.</p>
          </div>
        </div>
        <div className="panel-body profile-grid">
          <label className="field">
            <span>Name</span>
            <input value={orgName} onChange={(event) => setOrgName(event.target.value)} />
          </label>
          <button
            type="button"
            className="btn"
            disabled={!account.orgId || orgName.trim() === '' || busy !== null}
            onClick={() => void saveOrgName()}
          >
            {busy === 'org' ? 'Saving…' : 'Rename'}
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-body profile-signout-row">
          <span className="muted">Signed in as {account.email}</span>
          <button type="button" className="btn btn-quiet" onClick={() => void supabase?.auth.signOut()}>
            Sign out
          </button>
        </div>
      </section>

      {status ? <p className="muted">{status}</p> : null}
      {error ? <p className="import-error">{error}</p> : null}
    </div>
  );
}
