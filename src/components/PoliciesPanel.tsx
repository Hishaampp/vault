import { POLICIES, POLICY_KEYS } from '../engine/policies';
import type { ClusterActions, ClusterSnapshot, LiveSettings } from '../engine/snapshot';

interface Props {
  snap: ClusterSnapshot;
  actions: ClusterActions;
  onChange: () => void;
}

export function PoliciesPanel({ snap, actions, onChange }: Props) {
  const s = snap.settings;
  const set = async (patch: Partial<LiveSettings>) => { await actions.updateSettings(patch); onChange(); };
  return (
    <section className="panel policies" aria-labelledby="pol-title">
      <h2 id="pol-title">Policies</h2>
      <fieldset className="field">
        <legend className="lbl">Durability for new uploads</legend>
        <div className="seg">
          {POLICY_KEYS.map((k) => (
            <label key={k}>
              <input type="radio" name="policy" value={k} checked={s.policy === k} onChange={() => set({ policy: k })} />
              {POLICIES[k].label}
            </label>
          ))}
        </div>
        <p className="help" data-testid="policy-help">{POLICIES[s.policy].help}</p>
      </fieldset>
      <div className="field">
        <label className="lbl" htmlFor="dead-timeout">Declare a silent node dead after <span>{s.deadTimeout / 1000}s</span></label>
        <input id="dead-timeout" type="range" min={2} max={15} step={1} value={s.deadTimeout / 1000}
          onChange={(e) => set({ deadTimeout: Number(e.target.value) * 1000 })} />
        <p className="help">Shorter recovers faster; longer avoids rebuilding data for a node that was only briefly slow.</p>
      </div>
      <div className="field">
        <label className="lbl" htmlFor="concurrency">Parallel repairs <span>{s.concurrency}</span></label>
        <input id="concurrency" type="range" min={1} max={10} step={1} value={s.concurrency}
          onChange={(e) => set({ concurrency: Number(e.target.value) })} />
        <p className="help">More parallel repairs shorten recovery but compete with client reads.</p>
      </div>
      {s.bandwidth !== undefined && (
        <div className="field">
          <label className="lbl" htmlFor="bandwidth">Repair bandwidth per transfer <span>{s.bandwidth} MB/s</span></label>
          <input id="bandwidth" type="range" min={0.25} max={20} step={0.25} value={s.bandwidth}
            onChange={(e) => set({ bandwidth: Number(e.target.value) })} />
          <p className="help">Throttles repair traffic so it never starves client reads.</p>
        </div>
      )}
      <label className="tg">Background integrity scrubber
        <input type="checkbox" checked={s.scrub} onChange={(e) => set({ scrub: e.target.checked })} />
      </label>
      <label className="tg">{snap.mode === 'live' ? 'Background client traffic' : 'Simulated client traffic'}
        <input type="checkbox" checked={s.traffic} onChange={(e) => set({ traffic: e.target.checked })} />
      </label>
    </section>
  );
}
