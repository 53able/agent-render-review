// Approval dialogs: final render (app.js:566-587) and writing an adopted image into the project (app.js:121-146).
// Opening and closing go through the store, which pauses polling while a dialog is open; Esc and the buttons all end in
// onOpenChange(false) or an explicit decision.
import { useRef } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { closeAdoption, closeFinal, useStore } from '../store.ts';

const WIDE = 'data-[size=default]:max-w-[calc(100vw-2rem)] data-[size=default]:sm:max-w-[520px]';

function Plan({ id, rows }: { id: string; rows: [string, string, boolean?][] }) {
  return (
    <dl id={id} className="grid grid-cols-[max-content_1fr] gap-x-3.5 gap-y-1 text-sm">
      {rows.map(([k, x, flag], i) => (
        <div key={i} className="contents">
          <dt className={flag ? 'text-warn' : 'text-muted-foreground'}>{k}</dt>
          <dd className="font-mono break-all whitespace-pre-wrap">{x}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FinalDialog() {
  const d = useStore((s) => s.finalDlg);
  const decision = useRef('');
  if (!d) return null;
  const { plan } = d;
  const rows: [string, string, boolean?][] = [
    ['version', `${plan.versionId}${d.proposed ? ' (unaccepted proposal)' : ''}`], ['scene hash', plan.hash], ['profile', plan.profile],
    ['resolution', plan.resolution.join(' × ')], ['writes', plan.output + (plan.overwrites ? ' (replaces previous final)' : '')],
    ['time', `not predicted · ${plan.reference} · hard stop at ${plan.timeoutSec}s`], ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  if (plan.flags.length) rows.push(['attention', plan.flags.map((f) => f.msg).join('\n'), true]);
  return (
    <AlertDialog open={d.open} onOpenChange={(o) => { if (!o) void closeFinal(decision.current === 'approve'); else decision.current = ''; }}>
      <AlertDialogContent id="finalDlg" className={WIDE} onOpenAutoFocus={() => { decision.current = ''; }}>
        <AlertDialogHeader>
          <AlertDialogTitle className="tracking-normal text-foreground normal-case">Approve final render?</AlertDialogTitle>
          <AlertDialogDescription>Uses GPU time and writes a file. The approval covers exactly this scene.</AlertDialogDescription>
        </AlertDialogHeader>
        <Plan id="finalPlan" rows={rows} />
        <AlertDialogFooter>
          <AlertDialogCancel value="cancel" onClick={() => { decision.current = 'cancel'; }}>Cancel</AlertDialogCancel>
          <AlertDialogAction value="approve" id="approveBtn" onClick={() => { decision.current = 'approve'; }}>Approve and render</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AdoptDialog() {
  const d = useStore((s) => s.adoptDlg);
  const decision = useRef<'approve' | 'reject' | 'cancel'>('cancel');
  if (!d) return null;
  const { plan } = d;
  const rows: [string, string][] = [
    ['version', `${plan.versionId} (${plan.versionStatus})${plan.acceptsProposal ? ' — approving also accepts this proposal as HEAD' : ''}`],
    ['scene hash', plan.hash], ['agent says', plan.reason],
    ['writes', plan.writes.join('\n') + (plan.overwrites ? '\n(replaces the existing image)' : '')],
    ['final render', plan.needsFinalRender ? 'will run std/final first' : 'reuses the existing final render'],
    ['approval valid', `${plan.expiresInSec / 60} min, this scene only`],
  ];
  return (
    <AlertDialog open={d.open} onOpenChange={(o) => { if (!o) void closeAdoption(decision.current); }}>
      <AlertDialogContent id="adoptDlg" className={WIDE} onOpenAutoFocus={() => { decision.current = 'cancel'; }}>
        <AlertDialogHeader>
          <AlertDialogTitle className="tracking-normal text-foreground normal-case">Write this image into the project?</AlertDialogTitle>
          <AlertDialogDescription>Nothing is written until you approve.</AlertDialogDescription>
        </AlertDialogHeader>
        <Plan id="adoptPlan" rows={rows} />
        <AlertDialogFooter>
          <AlertDialogCancel value="cancel" onClick={() => { decision.current = 'cancel'; }}>Cancel</AlertDialogCancel>
          <AlertDialogAction value="reject" variant="destructive" onClick={() => { decision.current = 'reject'; }}>Reject request</AlertDialogAction>
          <AlertDialogAction value="approve" onClick={() => { decision.current = 'approve'; }}>Approve and write</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
