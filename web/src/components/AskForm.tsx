// Directing the agent and, in ADE mode, the messages it has read. The box names the version it goes to (#59).
import type { FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { V, askTarget, focusInstruction, get, isADE, set, submitAsk, useStore, viewV } from '../store.ts';
import { Errs } from './Panels.tsx';

const STARTERS = [
  '夜のシーンにして、seedの光だけで部屋を照らす',
  '選択した物体をマットな陶器に変える',
  'カメラを低くして見上げる構図にする',
  'rimライトを強めて輪郭を際立たせる',
];
const EVENT_TYPES = ['feedback', 'decision', 'direct_edit', 'adopted', 'adoption_rejected'];

function EventList() {
  const data = useStore((s) => s.data), ade = useStore(isADE);
  const evs = ade ? data.events.filter((e) => EVENT_TYPES.includes(e.type)).slice(-6).reverse() : [];
  return (
    <ol id="eventList" hidden={!evs.length} aria-label="Messages to the agent" className="mt-2.5 grid gap-1.5 text-xs">
      {evs.map((e) => {
        const read = e.seq <= data.agentCursor;
        const what = e.type === 'feedback'
          ? <>{e.comment}{e.selection.length ? <span className="hint"> [{e.selection.join(', ')}]</span> : null}</>
          : e.type === 'decision' ? `${e.decision} ${e.version}` : e.type === 'adopted' ? `adopted → ${e.asset}`
            : e.type === 'direct_edit' ? `edited ${e.node}.${e.field}` : `rejected adoption ${e.request}`;
        return (
          <li key={e.seq} className="border-l-2 pl-2">
            #{e.seq} <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{e.type}</Badge> · {what}{' '}
            <span className={read ? 'text-ok' : 'text-warn'}>{read ? '· read by agent' : '· not read yet'}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Where the text goes, above the box (#59). */
function AskTarget() {
  const ade = useStore(isADE), to = useStore(askTarget), viewId = useStore((s) => viewV(s).id);
  const status = useStore((s) => V(askTarget(s), s)?.status), n = useStore((s) => s.selection.size);
  return (
    <Label htmlFor="instruction" id="askTarget" className="mb-1 block leading-normal font-normal">
      {ade
        ? <>Feedback on <b>{to}</b>{' '}<span className="hint">({status}{n ? `, with ${n} selected object${n > 1 ? 's' : ''}` : ''})</span></>
        : <>New proposal based on <b>{to}</b>{to !== viewId ? <>{' '}<span className="hint">({viewId} is discarded, so HEAD)</span></> : null}</>}
    </Label>
  );
}

export function AskForm() {
  const ade = useStore(isADE), instruction = useStore((s) => s.instruction);
  const ctx = useStore((s) => s.ctx), selection = useStore((s) => s.selection);
  const setCtx = (k: keyof typeof ctx) => (c: boolean | 'indeterminate') => set({ ctx: { ...get().ctx, [k]: c === true } });
  const onSubmit = (e: FormEvent) => { e.preventDefault(); void submitAsk(); };
  return (
    <section aria-labelledby="h-ask">
      <h2 id="h-ask">{ade ? 'Feedback to your agent' : 'Direct the agent'}</h2>
      <p id="adeHint" className="hint" hidden={!ade}>
        {ade ? 'Your ADE agent writes the scenes. What you send here, with the selected objects and the version you are viewing, reaches it through wait_for_feedback.' : ''}
      </p>
      <form id="askForm" onSubmit={onSubmit}>
        <AskTarget />
        <Textarea id="instruction" rows={3} value={instruction} onChange={(e) => set({ instruction: e.target.value })}
          placeholder={ade ? '例: 選択した物体をもっと小さく。見出しの右側に余白を残したい' : '例: 選択した物体をマットな陶器にして、ライトを夕方の色に'} />
        <div id="starters" hidden={ade} className="my-1.5 flex flex-wrap gap-1.5">
          {STARTERS.map((s) => (
            <Button key={s} type="button" variant="outline" size="xs" className="h-auto rounded-full border-dashed py-0.5 font-normal whitespace-normal text-muted-foreground"
              onClick={() => { set({ instruction: s }); focusInstruction(); }}>{s}</Button>
          ))}
        </div>
        <fieldset className="ctx my-2 grid gap-1 rounded-md border px-2.5 py-1.5" hidden={ade}>
          <legend className="px-1 text-[11px] text-muted-foreground">Context sent with this request</legend>
          <Label className="font-normal text-muted-foreground"><Checkbox checked disabled /> Current scene JSON (required)</Label>
          <Label className="font-normal"><Checkbox id="ctxSelection" checked={ctx.selection} onCheckedChange={setCtx('selection')} /> Selected objects <span id="selCount">{selection.size ? `(${[...selection].join(', ')})` : '(none)'}</span></Label>
          <Label className="font-normal"><Checkbox id="ctxExposure" checked={ctx.exposure} onCheckedChange={setCtx('exposure')} /> Last exposure measurements</Label>
          <Label className="font-normal"><Checkbox id="ctxHistory" checked={ctx.history} onCheckedChange={setCtx('history')} /> Earlier requests in this branch</Label>
          <p className="hint">The image itself is not sent. The agent cannot run tools, read files or reach the network.</p>
        </fieldset>
        <Button type="submit" id="askBtn" className="font-semibold">{ade ? 'Send to agent' : 'Propose change'}</Button>
      </form>
      <Errs scope="ask" />
      <EventList />
    </section>
  );
}
