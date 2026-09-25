import { useEffect, useRef, useState, type DragEvent } from 'react';
import { fmtBytes } from '../engine/format';
import { POLICIES } from '../engine/policies';
import { nodeLookup, objectHealthIn, type ClusterActions, type ClusterSnapshot } from '../engine/snapshot';
import { ChunkMap, type VerifyMessage } from './ChunkMap';

export const MAX_UPLOAD = 8 * 1048576;

/** Blob.arrayBuffer with a FileReader fallback for older browsers. */
function readFile(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}
const HEALTH = { ok: ['Protected', 'ok'], deg: ['Degraded', 'warn'], risk: ['No spare left', 'warn'], lost: ['Unreadable', 'bad'] } as const;

interface Props {
  snap: ClusterSnapshot;
  actions: ClusterActions;
  onChange: () => void;
}

export function ObjectsPanel({ snap, actions, onChange }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [verify, setVerify] = useState<VerifyMessage | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = [...snap.objects].sort((a, b) => a.name.localeCompare(b.name));
  const current = list.find((o) => o.name === selected) ?? list[0] ?? null;
  const nodes = nodeLookup(snap.nodes);
  const policy = snap.settings.policy;

  // Results go stale as the cluster changes; clear them after a while.
  useEffect(() => {
    if (!verify) return;
    const id = window.setTimeout(() => setVerify(null), 15000);
    return () => window.clearTimeout(id);
  }, [verify]);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_UPLOAD) {
      setNote(`${file.name} is ${fmtBytes(file.size)}. Upload a file of 8 MB or less.`);
      return;
    }
    setNote(`Storing ${file.name}…`);
    const bytes = new Uint8Array(await readFile(file));
    const r = await actions.putObject(`uploads/${file.name}`, bytes, policy);
    setNote(r.ok ? `Stored ${file.name} as ${POLICIES[policy].label}` : r.reason ?? 'Upload failed.');
    if (r.ok) setSelected(`uploads/${file.name}`);
    onChange();
  }

  async function runVerify() {
    if (!current) return;
    setVerifying(true);
    const r = await actions.readObject(current.name);
    const text = r.ok
      ? `Read ${fmtBytes(r.size!)} and its SHA-256 matches the original exactly.${r.skipped ? ` Skipped ${r.skipped} corrupt piece${r.skipped > 1 ? 's' : ''}.` : ''}${r.decoded ? ` Rebuilt ${r.decoded} segment${r.decoded > 1 ? 's' : ''} from parity.` : ''}`
      : r.reason ? `Read failed. ${r.reason}` : `Checksum mismatch: got ${r.sha!.slice(0, 12)}…, expected ${r.expected!.slice(0, 12)}…`;
    await actions.note(r.ok ? 'heal' : 'bad', r.ok ? `Verified read of ${current.name}: bit-for-bit identical` : `Read of ${current.name} failed`);
    setVerify({ name: current.name, ok: r.ok, text });
    setVerifying(false);
    onChange();
  }

  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); };

  return (
    <section className="panel objects" aria-labelledby="obj-title">
      <div className="obj-head">
        <h2 id="obj-title">Objects</h2>
        <span className="muted">{list.length} objects</span>
      </div>
      <div className="obj-body">
        <div className="obj-side">
          <label
            className={`drop${over ? ' over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <input ref={fileRef} type="file" className="sr-only" aria-label="Upload a file" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
            <b>Upload a file</b> or drop it here
            <span className="drop-note" role="status">{note ?? `Up to 8 MB, stored as ${POLICIES[policy].label}`}</span>
          </label>
          <div className="olist">
            {list.length === 0 && <p className="empty">No objects yet. Upload a file to get started.</p>}
            {list.map((o) => {
              const h = objectHealthIn(nodes, o);
              const tot = h.ok + h.warn + h.bad || 1;
              const [word, tone] = HEALTH[h.worst];
              return (
                <button type="button" key={o.name} className="obj" aria-pressed={current?.name === o.name} onClick={() => setSelected(o.name)}>
                  <span className="nm mono" title={o.name}>{o.name}</span>
                  <span className={`hs ${tone}`}>{word}</span>
                  <span className="meta2">{fmtBytes(o.size)}, {POLICIES[o.policy].label}, v{o.version}</span>
                  <span className="hbar" aria-hidden="true">
                    <i style={{ width: `${(h.ok / tot) * 100}%`, background: 'var(--ok)' }} />
                    <i style={{ width: `${(h.warn / tot) * 100}%`, background: 'var(--warn)' }} />
                    <i style={{ width: `${(h.bad / tot) * 100}%`, background: 'var(--bad)' }} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
        {current ? (
          <ChunkMap
            snap={snap}
            nodes={nodes}
            obj={current}
            verify={verify}
            verifying={verifying}
            onVerify={runVerify}
            onDelete={async () => { await actions.deleteObject(current.name); setSelected(null); onChange(); }}
          />
        ) : (
          <p className="empty">Select an object to see where each piece lives.</p>
        )}
      </div>
    </section>
  );
}
