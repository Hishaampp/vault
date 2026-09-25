import type { ClusterSnapshot } from '../engine/snapshot';
import { Sparkline } from './Sparkline';

const last = (a: number[]) => (a.length ? a[a.length - 1] : 0);

export function MetricsPanels({ snap }: { snap: ClusterSnapshot }) {
  const s = snap.series;
  const backlog = snap.queueLength + snap.flights.length;
  return (
    <>
      <div className="panel">
        <div className="chart-head"><h2>Requests per second</h2><span className="chart-val">{Math.round(last(s.rps) + last(s.wps))}</span></div>
        <Sparkline
          label="Requests per second over the last 90 seconds"
          times={s.t} marks={s.marks} floor={10}
          series={[
            { label: 'Reads', data: s.rps, color: 'var(--accent)', fill: true },
            { label: 'Writes', data: s.wps, color: 'var(--ok)' },
            { label: 'Failed', data: s.fps, color: 'var(--bad)' },
          ]}
        />
        <div className="ckey"><span><i style={{ background: 'var(--accent)' }} />Reads</span><span><i style={{ background: 'var(--ok)' }} />Writes</span><span><i style={{ background: 'var(--bad)' }} />Failed</span></div>
      </div>
      <div className="panel">
        <div className="chart-head"><h2>Read latency, p99</h2><span className="chart-val">{Math.round(last(s.p99))}<small>ms</small></span></div>
        <Sparkline label="99th percentile read latency" times={s.t} marks={s.marks} floor={20} series={[{ label: 'p99', data: s.p99, color: 'var(--warn)', fill: true }]} />
        <div className="ckey"><span>Dashed lines mark injected faults</span></div>
      </div>
      <div className="panel">
        <div className="chart-head"><h2>Repair backlog</h2><span className="chart-val">{backlog}<small>pieces</small></span></div>
        <Sparkline label="Pieces waiting for repair" times={s.t} marks={s.marks} floor={5} series={[{ label: 'Backlog', data: s.q, color: 'var(--repair)', fill: true }]} />
        <div className="ckey"><span><i style={{ background: 'var(--repair)' }} />Queued and in flight</span></div>
      </div>
    </>
  );
}
