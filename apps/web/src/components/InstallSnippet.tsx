import { useState } from 'react';

export function InstallSnippet({ label, code }: { label?: string; code: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="install-snippet">
      {label ? <p className="install-snippet-label muted">{label}</p> : null}
      <div className="install-snippet-body">
        <pre className="code-block">
          <code>{code}</code>
        </pre>
        <button
          type="button"
          className="btn btn-quiet install-snippet-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}
