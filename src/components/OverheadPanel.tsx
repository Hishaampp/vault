import { overheadOf, type ClusterSnapshot } from '../engine/snapshot';
import { fmtBytes } from '../engine/format';
import { POLICIES, POLICY_KEYS } from '../engine/policies';

const pct = (logical: number, raw: number) => (logical ? `${Math.round((raw / logical - 1) * 100)}%` : '0%');

export function OverheadPanel({ snap }: { snap: ClusterSnapshot }) {
  const o = overheadOf(snap.objects);
  const rows = POLICY_KEYS.map((k) => o.rows.find((r) => r.policy === k)).filter((r) => !!r);
  return (
    <div className="panel ovr">
      <div className="chart-head"><h2>Storage overhead</h2><span className="chart-val">{pct(o.logical, o.raw)}<small>extra</small></span></div>
      <div className="table-scroll">
        <table>
          <thead><tr><th scope="col">Policy</th><th scope="col">Objects</th><th scope="col">Stored</th><th scope="col">Extra</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.policy}>
                <td>{POLICIES[r.policy].label}</td><td>{r.objects}</td><td>{fmtBytes(r.raw)}</td><td>{pct(r.logical, r.raw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Erasure 4+2 survives the same two failures as three copies while using a quarter of the extra space.</p>
    </div>
  );
}
