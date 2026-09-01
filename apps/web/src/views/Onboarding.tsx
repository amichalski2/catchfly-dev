import { useState } from 'react';

import { ApiError, createProject, readStoredAdminKey, storeAdminKey } from '../data/api.ts';

export function Onboarding() {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [adminKey, setAdminKey] = useState(readStoredAdminKey);
  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState('');

  const updateName = (value: string) => {
    setName(value);
    setId(value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63));
  };

  async function submit(): Promise<void> {
    setStatus('working');
    setError('');
    try {
      await createProject({ id, name: name.trim(), description: description.trim(), adminKey });
      storeAdminKey(adminKey);
      setStatus('done');
      window.location.hash = `#/p/${encodeURIComponent(id)}/sources`;
      window.location.reload();
    } catch (cause) {
      setStatus('idle');
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  }

  return (
    <div className="onboarding-shell">
      <section className="onboarding-card">
        <img src="/brand/catchfly-lockup.png" alt="Catchfly" className="onboarding-logo" />
        <p className="eyebrow">Self-hosted workspace</p>
        <h1>Create your first project</h1>
        <p className="muted">
          A project keeps one WebMCP application's traces, tool manifests and eval history together.
          Catchfly creates a Production environment to get you started.
        </p>

        <label className="field field-grow">
          <span>Project name</span>
          <input autoFocus value={name} placeholder="Checkout agent" onChange={(event) => updateName(event.target.value)} />
        </label>
        <label className="field field-grow">
          <span>Project ID</span>
          <input value={id} placeholder="checkout-agent" onChange={(event) => setId(event.target.value)} />
        </label>
        <label className="field field-grow">
          <span>Description</span>
          <input value={description} placeholder="WebMCP checkout flow" onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="field field-grow">
          <span>Installation admin key</span>
          <input type="password" value={adminKey} placeholder="CATCHFLY_ADMIN_KEY" onChange={(event) => setAdminKey(event.target.value)} />
        </label>
        <p className="table-note">
          This bootstrap key comes from the <code>CATCHFLY_ADMIN_KEY</code> environment variable.
          Project-scoped keys are created in the next step.
        </p>
        {error ? <p className="import-error">{error}</p> : null}
        <button className="btn" type="button" disabled={!name.trim() || id.length < 2 || !adminKey || status === 'working'} onClick={() => void submit()}>
          {status === 'working' ? 'Creating project…' : 'Create project'}
        </button>
      </section>
    </div>
  );
}
