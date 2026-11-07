// Every version, newest first, indented where the history branches (app.js:177-191).
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { depth } from '../lib/depth.ts';
import { selectVersion, useStore } from '../store.ts';

const ORIGIN_COLOR: Record<string, string> = { agent: 'text-agent', human: 'text-human' };
const INDENT = ['', 'ml-2.5', 'ml-5', 'ml-7.5'];

export function VersionList() {
  const data = useStore((s) => s.data), viewId = useStore((s) => s.viewId);
  return (
    <ol id="versionList" className="flex flex-col gap-1">
      {[...data.versions].reverse().map((v) => {
        const title = v.origin === 'starter' ? 'Starter scene' : v.instruction;
        const discarded = v.status === 'discarded';
        return (
          <li key={v.id} className={`${INDENT[depth(v, data.versions)]} ${discarded ? 'opacity-45' : ''}`}>
            <Button variant="ghost" aria-current={v.id === viewId} data-id={v.id} onClick={() => selectVersion(v.id)}
              className="grid h-auto w-full grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-transparent px-2 py-1.5 text-left font-normal whitespace-normal aria-[current=true]:border-primary aria-[current=true]:bg-primary/10">
              <span className="font-mono text-[11px] text-muted-foreground">
                {v.id}{v.parent ? ` ← ${v.parent}` : ''} {v.id === data.head ? <span className="text-[10px] text-primary">● HEAD</span> : null}
              </span>
              <Badge variant="outline" className={`justify-self-end border-current text-[10px] ${ORIGIN_COLOR[v.origin] ?? 'text-muted-foreground'}`}>{v.origin}</Badge>
              <span className={`col-span-full line-clamp-2 overflow-hidden ${discarded ? 'line-through' : ''}`}>
                {v.status === 'proposed' ? <span className="text-[10px] text-warn">PROPOSAL · </span> : null}{title}
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
