export interface SparkSeries {
  data: number[];
  color: string;
  fill?: boolean;
  label: string;
}

interface Props {
  series: SparkSeries[];
  /** sample times (ms), aligned with each series */
  times: number[];
  /** fault timestamps drawn as dashed markers */
  marks?: number[];
  /** lower bound for the y-axis maximum */
  floor?: number;
  capacity?: number;
  label: string;
}

const W = 300;
const H = 92;

/** Responsive SVG line chart: stretches to its container width. */
export function Sparkline({ series, times, marks = [], floor = 1, capacity = 90, label }: Props) {
  let max = floor;
  for (const s of series) for (const v of s.data) max = Math.max(max, v);
  max *= 1.15;
  const x = (i: number, len: number) => (W * (capacity - len + i)) / (capacity - 1);
  const y = (v: number) => H - 2 - ((H - 4) * v) / max;
  const tNow = times.length ? times[times.length - 1] : 0;
  const span = (capacity - 1) * 1000;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {[1, 2, 3].map((g) => (
        <line key={g} x1="0" x2={W} y1={H - (H * g) / 4} y2={H - (H * g) / 4} className="grid" vectorEffect="non-scaling-stroke" />
      ))}
      {times.length > 0 && marks.map((m, i) => {
        const mx = W * (1 - (tNow - m) / span);
        if (mx < 0 || mx > W + 2) return null;
        return <line key={i} x1={mx} x2={mx} y1="0" y2={H} className="mark" vectorEffect="non-scaling-stroke" />;
      })}
      {series.map((s) => {
        if (s.data.length < 2) return null;
        const pts = s.data.map((v, i) => `${x(i, s.data.length)},${y(v)}`);
        const line = `M${pts.join(' L')}`;
        const area = `${line} L${x(s.data.length - 1, s.data.length)},${H} L${x(0, s.data.length)},${H} Z`;
        return (
          <g key={s.label}>
            {s.fill && <path d={area} fill={s.color} opacity="0.12" />}
            <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}
    </svg>
  );
}
