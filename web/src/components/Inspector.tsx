// Inspector head: the version on screen, its state and what can be done with it (#56): accept, refine, discard (with
// undo, #55), make an accepted version HEAD again (#55), and the final render planned inline (#57).
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  approveFinal, checkout, closeFinalPlan, decide, discarding, planFinal, refine, reviewAdoption, runningJob, say, undoDiscard, useStore, viewV,
} from '../store.ts';
import { Errs } from './Panels.tsx';

const STATUS_TEXT: Record<string, string> = { proposed: 'Proposal — not applied yet', accepted: 'Accepted', discarded: 'Discarded' };

function Decide() {
  const v = useStore(viewV), head = useStore((s) => s.data.head), gone = useStore((s) => discarding(viewV(s).id, s));
  if (gone) return <span id="decide" className="btnrow"><span className="text-warn">Will be discarded in a few seconds</span><Button variant="outline" id="undoHere" onClick={undoDiscard}>Undo discard</Button></span>;
  if (v.status === 'accepted' && v.id !== head) return <span id="decide" className="btnrow"><Button variant="outline" id="headBtn" onClick={() => void checkout(v.id)}>Make HEAD</Button></span>;
  if (v.status !== 'proposed') return <span id="decide" className="btnrow" />;
  return (
    <span id="decide" className="btnrow">
      <Button id="acceptBtn" className="font-semibold" onClick={() => void decide('accept')}>Accept as new HEAD</Button>
      <Button id="refineBtn" variant="outline" onClick={refine}>Refine from this</Button>
      <Button id="discardBtn" variant="destructive" onClick={() => void decide('discard')}>Discard</Button>
    </span>
  );
}

function FinalPlanBox() {
  const fp = useStore((s) => s.finalPlan);
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (fp) h.current?.focus(); }, [fp]);
  const close = () => { closeFinalPlan(true); say('Final render not started'); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  const rows: [string, string][] = [];
  if (fp) {
    const { plan } = fp;
    rows.push(
      ['version', `${plan.versionId}${fp.proposed ? ' (unaccepted proposal)' : ''}`], ['scene hash', plan.hash], ['profile', plan.profile],
      ['resolution', plan.resolution.join(' × ')], ['writes', plan.output + (plan.overwrites ? ' (replaces previous final)' : '')],
      ['time', `not predicted · ${plan.reference} · hard stop at ${plan.timeoutSec}s`], ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
    );
  }
  return (
    <section id="finalPlanBox" className="planbox" hidden={!fp} aria-labelledby="h-fplan" onKeyDown={onKey}>
      <h3 id="h-fplan" ref={h} tabIndex={-1} className="m-0 text-[13px] font-semibold outline-none">{fp ? `Final render of ${fp.plan.versionId}` : 'Final render'}</h3>
      <p className="hint">Uses GPU time and writes a file. The approval covers this exact scene; switching versions closes the plan.</p>
      <dl id="finalPlan" className="plan">
        {rows.map(([k, x]) => <div key={k} className="contents"><dt>{k}</dt><dd>{x}</dd></div>)}
        {fp?.plan.flags.length
          ? <div className="contents"><dt className="text-warn">attention</dt><dd className="whitespace-pre-wrap">{fp.plan.flags.map((f) => f.msg).join('\n')}</dd></div>
          : null}
      </dl>
      <div className="btnrow">
        <Button type="button" id="finalApprove" className="font-semibold" onClick={() => void approveFinal()}>Approve and render</Button>
        <Button type="button" id="finalCancel" variant="outline" onClick={close}>Cancel</Button>
      </div>
    </section>
  );
}

export function InspectorHead() {
  const v = useStore(viewV), head = useStore((s) => s.data.head), reqsAll = useStore((s) => s.data.adoptionRequests);
  const gone = useStore((s) => discarding(viewV(s).id, s));
  const busy = useStore((s) => runningJob(viewV(s).id, 'render', s) ?? runningJob(viewV(s).id, 'adopt', s));
  const reqs = (reqsAll || []).filter((a) => a.version === v.id && (a.status === 'pending' || a.status === 'adopting'));
  const state = [v.id === head ? 'HEAD' : v.status === 'accepted' ? 'accepted, not HEAD' : '', v.parent ? `from ${v.parent}` : '', `by ${v.origin}`].filter(Boolean);
  return (
    <section className="vhead" aria-labelledby="h-insp">
      <h2 id="h-insp" className="insp-title">{`${v.id} · ${v.origin === 'starter' ? 'Starter scene' : STATUS_TEXT[v.status] || v.status}`}</h2>
      <p id="vstate" className="m-0 text-muted-foreground">
        {state.map((x, i) => <span key={i}>{i ? ' · ' : ''}{x === 'HEAD' ? <b>HEAD</b> : x}</span>)}
      </p>
      <div className="btnrow" id="actions">
        <Decide />
        <Button id="finalBtn" variant="outline" hidden={v.status === 'discarded'} disabled={!!busy} onClick={() => void planFinal()}>Plan final render…</Button>
      </div>
      <p id="finalBusy" className="hint" hidden={!busy}>{busy ? `${v.id} has a running job (${busy.kind}); plan the final render when it ends.` : ''}</p>
      <FinalPlanBox />
      <ul id="vrequests" className="alist" hidden={!reqs.length} aria-label="Adoption requests for this version">
        {reqs.map((a) => (
          <li key={a.id}>
            <span>Adoption request <b>{a.slug}</b></span>
            {a.status === 'adopting' ? <span className="hint">adopting…</span>
              : gone ? <span className="hint">rejected when the discard is final</span>
                : <Button variant="outline" size="sm" data-req={a.id} onClick={() => void reviewAdoption(a.id)}>Review…</Button>}
          </li>
        ))}
      </ul>
      <Errs scope="review" />
      <Errs scope="final" />
    </section>
  );
}
