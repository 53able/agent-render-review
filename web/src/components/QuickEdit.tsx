// Direct edit of one selected object without the agent.
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { hexToLin, isColor, linToHex } from '../lib/color.ts';
import type { QuickRow } from '../lib/types.ts';
import { decide, directEdit, discarding, openVersion, useStore, viewV } from '../store.ts';

const fmtColor = (lin: number[]) => lin.map((c) => c.toFixed(2)).join(',');

/**
 * One control row. These are native range/color inputs on purpose (the only raw inputs outside components/ui):
 * the browser fires `input` while dragging and `change` once on release. React's onChange fires on every native `input`,
 * which would create a version from the value at the start of a drag. So the display follows `input` and the edit is
 * sent on `change`, both through addEventListener on a ref. The duplicate-version guard is directEdit's synchronous flag.
 * When the edit fails, the control goes back to the value of the version shown.
 */
function QuickRowControl({ node, row }: { node: string; row: QuickRow }) {
  const [field, label, kind, val, min, max, step] = row;
  const ref = useRef<HTMLInputElement>(null), out = useRef<HTMLOutputElement>(null);
  // By value: a poll hands over a new array for the same colour, which must not re-attach the listeners.
  const initial = kind === 'color' ? linToHex(val as number[]) : String(Number(val));
  useEffect(() => {
    const el = ref.current!, o = out.current!;
    const show = () => { o.textContent = kind === 'color' ? fmtColor(hexToLin(el.value)) : el.value; };
    const commit = () => {
      void directEdit(node, field, kind === 'color' ? hexToLin(el.value) : Number(el.value)).then((ok) => {
        if (!ok && el.isConnected) { el.value = initial; show(); }
      });
    };
    el.value = initial; show();
    el.addEventListener('input', show); el.addEventListener('change', commit);
    return () => { el.removeEventListener('input', show); el.removeEventListener('change', commit); };
  }, [node, field, kind, initial]);
  return (
    <Label className="row grid grid-cols-[110px_1fr_auto] gap-2 font-normal">
      <span className="text-muted-foreground">{label}</span>
      {kind === 'color'
        ? <input ref={ref} type="color" defaultValue={initial} />
        : <input ref={ref} type="range" className="w-full" min={min} max={max} step={step} defaultValue={initial} />}
      <output ref={out} className="min-w-9 text-right font-mono text-[11px]" />
    </Label>
  );
}

export function QuickEdit() {
  const v = useStore(viewV), selection = useStore((s) => s.selection), head = useStore((s) => s.data.head);
  const gone = useStore((s) => discarding(viewV(s).id, s));
  let body: React.ReactNode = null;
  if (v.status !== 'accepted') {
    // Say why, next to what lifts it (#59).
    body = <>
      <p className="hint">Direct edits start from an accepted version; {v.id} is {v.status}.</p>
      <div className="btnrow">
        {v.status === 'proposed' && !gone ? <Button type="button" variant="outline" size="sm" id="qAccept" onClick={() => void decide('accept', v.id)}>Accept this proposal</Button> : null}
        <Button type="button" variant="outline" size="sm" id="qHead" onClick={() => openVersion(head)}>Open HEAD ({head})</Button>
      </div>
    </>;
  } else if (selection.size !== 1) body = selection.size ? null : <p className="hint">Select one object to edit it directly, without the agent.</p>;
  else {
    const n = v.scene.nodes.find((x) => x.name === [...selection][0]);
    if (n) {
      const rows: QuickRow[] = [];
      if (n.type === 'mesh') {
        const inp = n.materials?.[0]?.inputs || {};
        if (isColor(inp.base_color) || inp.base_color === undefined) rows.push(['base_color', 'Base colour', 'color', inp.base_color || [0.8, 0.8, 0.8]]);
        rows.push(['specular_roughness', 'Roughness', 'range', inp.specular_roughness ?? 0.5, 0, 1, 0.01]);
        rows.push(['emission_luminance', 'Emission (nits)', 'range', inp.emission_luminance ?? 0, 0, 100, 1]);
      } else if (n.type === 'light') {
        rows.push(['energy', n.shape === 'sun' ? 'Energy (W/m²)' : 'Energy (W)', 'range', n.energy ?? 100, 0, 3000, 10]);
        if (isColor(n.color)) rows.push(['color', 'Colour', 'color', n.color]);
      }
      body = !rows.length
        ? <p className="hint">No direct controls for this object type. Ask the agent instead.</p>
        : <>
          <p className="hint">Direct edit of <b>{n.name}</b> creates a new human version from {v.id}. Changes apply on release.</p>
          {/* keyed by version so each row starts from the value of the version shown */}
          {rows.map((r) => <QuickRowControl key={`${v.id}:${n.name}:${r[0]}`} node={n.name} row={r} />)}
        </>;
    }
  }
  return <div id="quick" className="mt-2.5 grid gap-2">{body}</div>;
}
