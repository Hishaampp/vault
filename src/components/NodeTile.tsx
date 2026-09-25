import { fmtBytes } from '../engine/format';
import type { NodeInfo } from '../engine/snapshot';
import type { NodeStatus } from '../engine/types';

export const STATUS_LABEL: Record<NodeStatus, string> = {
  healthy: 'Online',
  suspect: 'Missed heartbeats',
  unreachable: 'Unreachable',
  dead: 'Declared dead',
};
const MAX_SQUARES = 150;

interface Props {
  node: NodeInfo;
  hues: Record<string, string>;
  selected: boolean;
  receiving: boolean;
  onSelect: (id: string) => void;
}

export function NodeTile({ node, hues, selected, receiving, onSelect }: Props) {
  const shown = node.pieces.slice(0, MAX_SQUARES);
  const more = node.pieceCount - shown.length;
  return (
    <button
      type="button"
      className="node"
      data-node-id={node.id}
      data-status={node.status}
      data-receiving={receiving || undefined}
      aria-pressed={selected}
      aria-label={`${node.id}, rack ${node.rack}, ${STATUS_LABEL[node.status]}${node.up ? '' : ', process stopped'}, ${node.pieceCount} pieces`}
      onClick={() => onSelect(node.id)}
    >
      <span className="node-top">
        <span>
          <span className="node-id mono">{node.id}</span>
          {!node.up && <span className="stopped">process stopped</span>}
        </span>
        <span className="node-st">{STATUS_LABEL[node.status]}</span>
      </span>
      <span className="pgrid" aria-hidden="true">
        {shown.map((p) => (
          <i key={p.key} className={p.corrupt ? 'pc bad' : p.rot ? 'pc rot' : 'pc'} style={{ ['--c' as string]: hues[p.name] ?? '#8FA0B8' }} />
        ))}
        {more > 0 && <span className="pmore">+{more}</span>}
      </span>
      <span className="node-foot">
        <span>{node.pieceCount} pieces</span>
        <span>{fmtBytes(node.bytes)}</span>
      </span>
    </button>
  );
}
