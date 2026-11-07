// The smaller panels: failures next to what failed (#53), the connection banner (#53), adoption requests, the jobs of
// each version (#54), the audit log, the discard undo bar (#55) and the narrow-screen tabs (#60).
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { Scope } from '../store.ts';
import { cancelAdoption, cancelJob, dismissFail, dropJob, reviewAdoption, setPane, undoDiscard, useStore } from '../store.ts';

/** The failures of one scope (#err-<scope>), each with Dismiss and, when it can be repeated, a retry. */
export function Errs({ scope }: { scope: Scope }) {
  const fails = useStore((s) => s.fails[scope]);
  return (
    <div id={`err-${scope}`} className="errs">
      {fails.map((f) => (
        <div key={f.key} className="err" role="alert">
          <span className="msg">{f.msg}</span>
          {f.retry
            ? <Button type="button" variant="outline" size="xs" onClick={() => { dismissFail(scope, f.key); void f.retry?.(); }}>{f.retryLabel || 'Try again'}</Button>
            : null}
          <Button type="button" variant="outline" size="xs" aria-label="Dismiss" onClick={() => dismissFail(scope, f.key)}>✕</Button>
        </div>
      ))}
    </div>
  );
}

export function Conn() {
  const since = useStore((s) => s.connLost);
  return (
    <div id="conn" className="conn" role="alert" hidden={!since}>
      {since ? `Director is not responding (since ${since}). What you see may be out of date; retrying every few seconds. If it stopped, start it again or ask your agent to call director_status.` : null}
    </div>
  );
}

export function AdoptionList() {
  const reqs = useStore((s) => s.data.adoptionRequests);
  // 'adopting': its adopt job is running; the server refuses plan and reject until the job ends or is cancelled.
  const pending = (reqs || []).filter((a) => a.status === 'pending' || a.status === 'adopting');
  return (
    <section id="adoptBox" hidden={!pending.length} aria-labelledby="h-adopt" className="rounded-lg border border-primary p-2.5">
      <h2 id="h-adopt">Adoption requests</h2>
      <ul id="adoptList" className="alist">
        {pending.map((a) => (
          <li key={a.id}>
            <span><b>{a.slug}</b> from {a.version}</span>
            {a.status === 'adopting'
              ? <span className="flex items-center gap-2"><span className="hint">adopting…</span><Button variant="outline" size="sm" data-cancel={a.job} onClick={() => a.job && void cancelAdoption(a.job)}>Cancel</Button></span>
              : <Button variant="outline" size="sm" data-req={a.id} onClick={() => void reviewAdoption(a.id)}>Review…</Button>}
            <span className="why">{a.reason}</span>
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
const JOB_TITLE: Record<string, string> = { render: 'Render', propose: 'Proposal from', adopt: 'Adoption of' };

/** Every job this tab started, per version (#54). Rows are keyed by job, so Cancel keeps focus while the steps update. */
export function JobBox() {
  const jobs = useStore((s) => s.jobs);
  return (
    <section id="jobBox" hidden={!jobs.size} aria-labelledby="h-job" className="rounded-lg border p-2.5">
      <h2 id="h-job">Working</h2>
      <ol id="jobList" className="grid gap-2.5">
        {[...jobs.values()].map((j) => {
          const running = j.status === 'running';
          return (
            <li key={j.id} className="jobrow" data-job={j.id} data-version={j.versionId} data-status={j.status}>
              <div className="mb-1 flex items-center gap-2">
                <b className={j.status === 'failed' || j.status === 'cancelled' ? 'text-destructive' : ''}>{JOB_TITLE[j.kind] || j.kind} {j.versionId}</b>
                <span className="hint mr-auto my-0">{running ? `elapsed ${(j.elapsed / 1000).toFixed(0)}s (no ETA: agent and GPU time vary)` : j.status}</span>
                {running
                  ? <Button type="button" variant="outline" size="sm" data-cancel-job={j.id} onClick={() => cancelJob(j.id)}>Cancel</Button>
                  : <Button type="button" variant="outline" size="sm" data-dismiss-job={j.id} aria-label="Dismiss" onClick={() => dropJob(j.id)}>✕</Button>}
              </div>
              <ol className="grid gap-1">
                {j.steps.map((s, i) => {
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function AuditLog() {
  const audit = useStore((s) => s.data.audit);
  return (
    <Collapsible id="auditbox" className="auditbox">
      <CollapsibleTrigger asChild>
        <Button variant="link" size="xs" className="px-0 text-muted-foreground">History (audit log)</Button>
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

export function UndoBar() {
  const id = useStore((s) => s.pendingDiscard);
  return (
    <div id="undoBar" className="undo" role="status" hidden={!id}>
      <span><b>{id}</b> will be discarded</span>
      <Button type="button" variant="outline" size="sm" id="undoBtn" onClick={undoDiscard}>Undo</Button>
    </div>
  );
}

/** Narrow screens only: the two panels below the render are tabs (#60). */
export function PaneTabs() {
  const pane = useStore((s) => s.pane);
  const tab = (id: string, value: typeof pane, label: string, controls: string) => (
    <Button type="button" variant="ghost" size="sm" role="tab" id={id} aria-controls={controls} aria-selected={pane === value} onClick={() => setPane(value)}>{label}</Button>
  );
  return (
    <div className="panetabs" role="tablist" aria-label="Panel below the render">
      {tab('tab-insp', 'inspector', 'This version', 'inspector')}
      {tab('tab-versions', 'versions', 'All versions', 'versions')}
    </div>
  );
}
