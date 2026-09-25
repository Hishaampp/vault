import { useEffect, useRef, type RefObject } from 'react';
import type { FlightInfo } from '../engine/snapshot';

interface Props {
  flights: FlightInfo[];
  /** performance.now() when `flights` was captured */
  at: number;
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * Draws animated repair and rebalance transfers between node tiles.
 * Writes SVG directly each animation frame to avoid 60fps React renders.
 */
export function FlowOverlay({ flights, at, containerRef }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const data = useRef({ flights, at });
  data.current = { flights, at };

  useEffect(() => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = '';
    const draw = () => {
      const svg = svgRef.current;
      const box = containerRef.current;
      if (svg && box) {
        const b = box.getBoundingClientRect();
        const center = (id: string) => {
          const el = box.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2 };
        };
        const since = performance.now() - data.current.at;
        let html = '';
        for (const f of data.current.flights) {
          const to = center(f.target);
          if (!to) continue;
          const color = f.kind === 'move' ? 'var(--accent)' : 'var(--repair)';
          const p = Math.min(1, (f.elapsed + since) / Math.max(1, f.dur));
          for (const src of f.srcs) {
            const from = center(src);
            if (!from || (Math.abs(from.x - to.x) < 1 && Math.abs(from.y - to.y) < 1)) continue;
            const mx = (from.x + to.x) / 2 + (from.y === to.y ? 0 : 28);
            const my = (from.y + to.y) / 2 - 28 - Math.abs(from.x - to.x) * 0.12;
            html += `<path d="M${from.x},${from.y} Q${mx},${my} ${to.x},${to.y}" fill="none" stroke="${color}" stroke-width="1.6" stroke-opacity=".45" stroke-dasharray="4 4"/>`;
            if (!reduce) {
              const u = 1 - p;
              const x = u * u * from.x + 2 * u * p * mx + p * p * to.x;
              const y = u * u * from.y + 2 * u * p * my + p * p * to.y;
              html += `<circle cx="${x}" cy="${y}" r="4.5" fill="${color}"/>`;
            }
          }
        }
        if (html !== last) { svg.innerHTML = html; last = html; }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [containerRef]);

  return <svg ref={svgRef} className="flows" aria-hidden="true" />;
}
