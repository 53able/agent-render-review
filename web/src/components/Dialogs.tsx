// Approval dialog for writing an adopted image into the project, with the images being decided on (#58). Esc and the
// buttons all end in onOpenChange(false) with the decision taken. The final render is planned inline (Inspector.tsx).
import { useRef } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { AdoptPlan } from '../lib/types.ts';
import { closeAdoption, useStore } from '../store.ts';

const WIDE = 'max-h-[calc(100vh-2rem)] overflow-auto data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-[960px]';
const kb = (n: number | null) => (n == null ? '' : ` · ${(n / 1024).toFixed(0)} KB`);

/** What will be written, and what it replaces. */
function AdoptImages({ plan }: { plan: AdoptPlan }) {
  const ex = plan.existing; const to = plan.writes[0];
  return (
    <div id="adoptImages" className="adoptimgs">
      <figure>
        <figcaption>Writes{plan.needsFinalRender ? <> <span className="text-warn">({plan.shows} shown; rendered again at final quality before writing)</span></> : ' (the final render)'}</figcaption>
        {plan.image ? <img className="write" src={plan.image} alt={`The image that will be written to ${to}`} /> : <p className="hint">No render of this version yet.</p>}
      </figure>
      {ex
        ? <figure>
          <figcaption>Replaces {to}{ex.modified ? ` · modified ${new Date(ex.modified).toLocaleString()}` : ''}{kb(ex.bytes)}</figcaption>
          {ex.image ? <img className="existing" src={ex.image} alt="The image in the project now, which will be replaced" /> : <p className="text-warn">The existing file cannot be shown (not a plain file with a single link).</p>}
        </figure>
        : <figure><figcaption>Replaces nothing (a new file)</figcaption></figure>}
    </div>
  );
}

export function AdoptDialog() {
  const d = useStore((s) => s.adoptDlg);
  const decision = useRef<'approve' | 'reject' | 'cancel'>('cancel');
  if (!d) return null;
  const { plan, requestId } = d;
  const rows: [string, string][] = [
    ['version', `${plan.versionId} (${plan.versionStatus})${plan.acceptsProposal ? ' — approving also accepts this proposal as HEAD' : ''}`],
    ['scene hash', plan.hash], ['agent says', plan.reason],
    ['writes', plan.writes.join('\n') + (plan.overwrites ? '\n(replaces the existing image)' : '')],
    ['final render', plan.needsFinalRender ? 'will run std/final first' : 'reuses the existing final render'],
    ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  // Focus goes back to this request's Review… button (the list may have been redrawn while the dialog was open).
  const onCloseAutoFocus = (e: Event) => {
    if (decision.current === 'approve') return;
    const back = document.querySelector<HTMLElement>(`#adoptList button[data-req="${CSS.escape(requestId)}"]`);
    if (back) { e.preventDefault(); back.focus(); }
  };
  return (
    <AlertDialog open={d.open} onOpenChange={(o) => { if (!o) void closeAdoption(decision.current); }}>
      <AlertDialogContent id="adoptDlg" className={WIDE} onOpenAutoFocus={() => { decision.current = 'cancel'; }} onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle className="tracking-normal text-foreground normal-case">Write this image into the project?</AlertDialogTitle>
          <AlertDialogDescription>Nothing is written until you approve.</AlertDialogDescription>
        </AlertDialogHeader>
        <AdoptImages plan={plan} />
        <dl id="adoptPlan" className="plan max-w-160">
          {rows.map(([k, x]) => <div key={k} className="contents"><dt>{k}</dt><dd className="whitespace-pre-wrap break-all">{x}</dd></div>)}
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel value="cancel" onClick={() => { decision.current = 'cancel'; }}>Cancel</AlertDialogCancel>
          <AlertDialogAction value="reject" variant="destructive" onClick={() => { decision.current = 'reject'; }}>Reject request</AlertDialogAction>
          <AlertDialogAction value="approve" onClick={() => { decision.current = 'approve'; }}>Approve and write</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
