// The smaller panels of the right column: adoption requests (app.js:108-146), the running job (app.js:431-459),
// the final render button (app.js:566-571) and the audit log (app.js:588-593).
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cancelAdoption, cancelJob, planFinal, reviewAdoption, useStore } from '../store.ts';

export function AdoptionList() {
  const reqs = useStore((s) => s.data.adoptionRequests);
  // 'adopting': its adopt job is running; the server refuses plan and reject until the job ends or is cancelled.
  const pending = (reqs || []).filter((a) => a.status === 'pending' || a.status === 'adopting');
  return (
    <section id="adoptBox" hidden={!pending.length} aria-labelledby="h-adopt" className="rounded-lg border border-primary p-2.5">
      <h2 id="h-adopt">Adoption requests</h2>
      <ul id="adoptList" className="grid gap-1.5">
        {pending.map((a) => (
          <li key={a.id} className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1">
            <span><b>{a.slug}</b> from {a.version}</span>
            {a.status === 'adopting'
              ? <span className="flex items-center gap-2"><span className="hint">adopting…</span><Button variant="outline" size="sm" data-cancel={a.job} onClick={() => a.job && cancelAdoption(a.job)}>Cancel</Button></span>
              : <Button variant="outline" size="sm" data-req={a.id} onClick={() => reviewAdoption(a.id)}>Review…</Button>}
            <span className="col-span-full text-[11.5px] text-muted-foreground">{a.reason}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const STEP_ICON: Record<string, [string, string]> = {
  running: ['◌', 'text-primary motion-safe:inline-block motion-safe:animate-spin'],
  done: ['✓', 'text-ok'],
  failed: ['✕', 'text-destructive'],
};

export function JobBox() {
  const hidden = useStore((s) => s.jobBoxHidden), view = useStore((s) => s.jobView), job = useStore((s) => s.job);
  return (
    <section id="jobBox" hidden={hidden} aria-labelledby="h-job" className="rounded-lg border p-2.5">
      <h2 id="h-job">Working</h2>
      <ol id="jobSteps" className="grid gap-1">
        {view?.steps.map((s, i) => {
          const [icon, cls] = STEP_ICON[s.status] ?? ['', ''];
          return (
            <li key={i} className={`${s.status} grid grid-cols-[16px_1fr_auto] gap-1.5`}>
              <span aria-hidden="true"><span className={cls}>{icon}</span></span>
              <span>{s.label}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{(s.t / 1000).toFixed(1)}s</span>
              {s.detail ? <pre className="col-start-2 col-end-[-1] mt-0.5 max-h-30 overflow-auto text-[11px] whitespace-pre-wrap text-muted-foreground">{s.detail}</pre> : null}
            </li>
          );
        })}
      </ol>
      <div className="mt-2 flex items-center justify-between text-muted-foreground">
        <span id="jobElapsed">{view ? `elapsed ${(view.elapsed / 1000).toFixed(0)}s (no ETA: agent and GPU time vary)` : ''}</span>
        <Button id="cancelBtn" variant="outline" size="sm" hidden={!job} onClick={cancelJob}>Cancel</Button>
      </div>
    </section>
  );
}

export function FinalRender() {
  const job = useStore((s) => s.job);
  return (
    <section aria-labelledby="h-final">
      <h2 id="h-final">Final render</h2>
      <p className="hint">Uses GPU time and writes a file. Requires approval for the exact scene shown.</p>
      <Button id="finalBtn" variant="outline" disabled={!!job} onClick={() => void planFinal()}>Plan final render…</Button>
    </section>
  );
}

export function AuditLog() {
  const audit = useStore((s) => s.data.audit);
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button variant="link" size="xs" className="px-0 text-muted-foreground">Audit log</Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol id="audit" className="mt-1.5 grid max-h-50 gap-0.5 overflow-auto font-mono text-[10.5px] text-muted-foreground">
          {[...audit].reverse().map((a, i) => (
            <li key={i}>{a.t.slice(11, 19)} {a.event} {a.version || ''} {a.instruction ? `· ${a.instruction.slice(0, 40)}` : ''}</li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
