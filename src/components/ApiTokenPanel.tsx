import { useId, useState } from 'react';
import { getApiToken, setApiToken } from '../live/remote';

/** Lets the operator enter the API token the server requires for changes. Stored only in this browser. */
export function ApiTokenPanel() {
  const id = useId();
  const [value, setValue] = useState(getApiToken);
  const [saved, setSaved] = useState<string | null>(null);
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>API access</h2>
      <p className="panel-sub">This cluster requires a token for uploads, deletes, settings, and fault injection.</p>
      <form
        className="token-form"
        onSubmit={(e) => { e.preventDefault(); setApiToken(value.trim()); setSaved(value.trim() ? 'Token saved in this browser.' : 'Token removed.'); }}
      >
        <label htmlFor={`${id}-input`} className="lbl">API token</label>
        <div className="token-row">
          <input id={`${id}-input`} className="input" type="password" autoComplete="off" spellCheck={false}
            value={value} onChange={(e) => { setValue(e.target.value); setSaved(null); }} />
          <button type="submit" className="btn primary">Save</button>
        </div>
        <p className="help" role="status">{saved ?? 'Kept in this browser only and sent as a Bearer token.'}</p>
      </form>
    </section>
  );
}