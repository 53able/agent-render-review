// Every version, newest first, indented where the history branches. A version's state is a symbol and a word, so it
// does not rest on colour alone (#60); a version with a running job is marked (#54).
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { depth } from '../lib/depth.ts';
import { selectVersion, useStore } from '../store.ts';

const ORIGIN_COLOR: Record<string, string> = { agent: 'text-agent', human: 'text-human' };
const INDENT = ['', 'ml-2.5', 'ml-5', 'ml-7.5'];
const STATE_CHIP: Record<string, string> = { proposed: '◇ proposal', accepted: '✓ accepted', discarded: '✕ discarded' };

export function VersionList() {
  const data = useStore((s) => s.data), viewId = useStore((s) => s.viewId), pending = useStore((s) => s.pendingDiscard);
  const jobs = useStore((s) => s.jobs);
  const busy = new Set([...jobs.values()].filter((j) => j.status === 'running').map((j) => j.versionId));
  return (
    <ol id="versionList" className="vlist flex flex-col gap-1">
      {[...data.versions].reverse().map((v) => {
        const title = v.origin === 'starter' ? 'Starter scene' : v.instruction;
        const st = pending === v.id ? 'discarded' : v.status;
        return (
          <li key={v.id} className={`st-${st} ${INDENT[depth(v, data.versions)]}`}>
            <Button variant="ghost" aria-current={v.id === viewId} data-id={v.id} onClick={() => selectVersion(v.id)}
              className={`${busy.has(v.id) ? 'busy ' : ''}grid h-auto w-full grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-transparent px-2 py-1.5 text-left font-normal whitespace-normal aria-[current=true]:border-primary aria-[current=true]:bg-primary/10`}>
              <span className="vid font-mono text-[11px] text-muted-foreground">
                {v.id}{v.parent ? ` ← ${v.parent}` : ''} {v.id === data.head ? <span className="headmark">● HEAD</span> : null}
              </span>
              <Badge variant="outline" className={`justify-self-end border-current text-[10px] ${ORIGIN_COLOR[v.origin] ?? 'text-muted-foreground'}`}>{v.origin}</Badge>
              <span className="stchip">{STATE_CHIP[st] || st}</span>
              <span className="vtitle col-span-full line-clamp-2 overflow-hidden">{title}</span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
