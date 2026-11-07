// Reviewing a proposal (app.js:467-555): what the agent says against what actually changed in the scene.
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isColor, linToHex } from '../lib/color.ts';
import { checkClaims, groupDiffs, isWildcard } from '../lib/diff.ts';
import type { Diff, Job, Version } from '../lib/types.ts';
import { V, decide, dismissResult, refine, useStore, viewV } from '../store.ts';

const CAP = 200;

function Value({ v }: { v: unknown }) {
  if (v === undefined) return <span className="hint">—</span>;
  const s = JSON.stringify(v);
  return isColor(v)
    ? <><span className="mr-1 inline-block size-2.5 rounded-xs border border-white/20 align-[-1px]" style={{ background: linToHex(v) }} />{s}</>
    : <>{s}</>;
}

function DiffRow({ d, claimed }: { d: Diff; claimed: boolean }) {
  const cell = 'px-1 py-0.5 align-top font-mono whitespace-normal break-all';
  return (
    <TableRow className={claimed ? '' : 'unclaimed'}>
      <TableCell className={cell}>{d.node}{d.path ? `.${d.path}` : ''}{claimed ? null : <span className="font-sans text-warn"> ⚠ not mentioned</span>}</TableCell>
      <TableCell className={cell}><Value v={d.before} /></TableCell>
      <TableCell className={cell}><Value v={d.after} /></TableCell>
    </TableRow>
  );
}

const unclaimedNote = (ds: Diff[], isClaimed: (d: Diff) => boolean) => {
  const u = ds.filter((d) => !isClaimed(d)).length;
  return u ? <span className="text-warn"> · ⚠ {u} not mentioned</span> : null;
};

/** Failure and question states of the last built-in agent job; they are not tied to a version. */
function JobResultPanel({ r }: { r: Job }) {
  const kind = r.result.kind;
  return (
    <>
      {kind === 'question'
        ? <>
          <h3>Agent asks before changing anything</h3>
          <p className="text-sm">{r.result.proposal?.clarifying_question}</p>
          <p className="hint">Your request is kept in the box below. Add the missing detail and propose again.</p>
        </>
        : <Alert variant="destructive">
          <AlertTitle>No version was created</AlertTitle>
          <AlertDescription>
            <p>{kind === 'blocked' ? 'The proposal broke a project rule enforced outside the model:' : 'vork rejected the scene twice. Last error:'}</p>
            <pre className="hint whitespace-pre-wrap">{kind === 'blocked' ? r.result.policy.blockers.join('\n') : r.result.log?.slice(-800)}</pre>
            <p className="hint">Your request is kept. Try rephrasing, narrowing the selection, or edit directly.</p>
          </AlertDescription>
        </Alert>}
      <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" id="dismiss" onClick={dismissResult}>Dismiss</Button></div>
    </>
  );
}

/** Keyed by version: which groups are open and whether the remaining rows are shown survive poll re-renders of the same version. */
function ProposalPanel({ v }: { v: Version }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [shownMore, setShownMore] = useState(false);
  const parent = V(v.parent);
  const p = v.proposal;
  const { isClaimed, wildCount, ghost } = checkClaims(p.claimed_changes.map((c) => c.node), v.diff);
  const { groups, rest } = groupDiffs(v.diff, parent?.scene.nodes || [], v.scene.nodes);
  const hidden = rest.slice(CAP);
  const shown = shownMore ? rest : rest.slice(0, CAP);
  return (
    <>
      <h3>{v.status === 'proposed' ? 'Proposal — not applied yet' : v.status === 'accepted' ? 'Accepted proposal' : 'Discarded proposal'} · {v.id} from {v.parent}</h3>
      {parent?.status !== 'accepted'
        ? <p className="text-warn">⚠ Built on {v.parent}, which is {parent?.status}. Accepting this also accepts that version's changes (not shown in this diff).</p>
        : null}
      <div><h3>Request</h3>{v.instruction}</div>
      <div>
        <h3>Agent's reading</h3><p className="text-sm">{p.interpretation}</p>
        {p.assumptions.length ? <ul className="list-disc pl-4.5">{p.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
      </div>
      <div>
        <h3>What the agent says it changed</h3>
        <ul className="list-disc pl-4.5">
          {p.claimed_changes.map((c, i) => {
            const n = wildCount.get(c.node);
            return <li key={i}><b>{c.node}</b>{isWildcard(c.node) ? <span className="hint"> → {n} node{n === 1 ? '' : 's'}</span> : null}: {c.what} <span className="hint">— {c.why}</span></li>;
          })}
        </ul>
      </div>
      <div>
        <h3>What actually changed (computed from the scene)</h3>
        <Table className="text-[11.5px]">
          <TableHeader><TableRow><TableHead className="h-auto px-1 py-0.5 text-muted-foreground">node.field</TableHead><TableHead className="h-auto px-1 py-0.5 text-muted-foreground">before</TableHead><TableHead className="h-auto px-1 py-0.5 text-muted-foreground">after</TableHead></TableRow></TableHeader>
          <TableBody>
            {groups.map(({ type, kind, ds }, i) => (
              <TableRow key={`g${i}`} className="group">
                <TableCell colSpan={3} className="px-1 py-0.5 whitespace-normal">
                  {/* rows inside a group are built only when the human opens it */}
                  <Collapsible data-group={i} open={open.has(i)}
                    onOpenChange={(o) => setOpen((prev) => { const s = new Set(prev); if (o) s.add(i); else s.delete(i); return s; })}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="xs" className="h-auto px-1 font-normal whitespace-normal">
                        {ds.length} {type} node{ds.length > 1 ? 's' : ''} {kind} ({ds[0]!.node}{ds.length > 1 ? ` … ${ds.at(-1)!.node}` : ''}){unclaimedNote(ds, isClaimed)}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <Table className="mt-1 text-[11.5px]"><TableBody>{ds.map((d, j) => <DiffRow key={j} d={d} claimed={isClaimed(d)} />)}</TableBody></Table>
                    </CollapsibleContent>
                  </Collapsible>
                </TableCell>
              </TableRow>
            ))}
            {shown.map((d, j) => <DiffRow key={`r${j}`} d={d} claimed={isClaimed(d)} />)}
            {hidden.length && !shownMore
              ? <TableRow><TableCell colSpan={3} className="px-1 py-0.5 whitespace-normal">
                <Button type="button" variant="outline" size="xs" id="moreDiff" onClick={() => setShownMore(true)}>Show remaining {hidden.length} rows</Button>{unclaimedNote(hidden, isClaimed)}
              </TableCell></TableRow>
              : null}
            {!groups.length && !rest.length ? <TableRow><TableCell colSpan={3}>No changes</TableCell></TableRow> : null}
          </TableBody>
        </Table>
        {ghost.length ? <p className="text-warn">⚠ Claimed but not changed: {ghost.join(', ')}</p> : null}
      </div>
      {p.policy.flags.length
        ? <div><h3>Needs attention</h3><ul className="list-disc pl-4.5">{p.policy.flags.map((f, i) => <li key={i} className="text-warn">{f.level}: {f.msg}</li>)}</ul></div>
        : null}
      <Collapsible>
        <CollapsibleTrigger asChild><Button variant="link" size="xs" className="hint px-0">Context that was sent</Button></CollapsibleTrigger>
        <CollapsibleContent><pre className="hint whitespace-pre-wrap">{p.context.join('\n\n') || 'scene only'}</pre></CollapsibleContent>
      </Collapsible>
      <p className="hint">
        {p.via === 'mcp' ? <Badge variant="outline" className="mr-1 text-agent">MCP</Badge> : null}
        {p.via === 'mcp' ? 'Proposed by your ADE agent via MCP' : `Agent cost ${p.cost ? '$' + p.cost.toFixed(3) : 'n/a'}`}. Judge the image, not the explanation.
      </p>
      {v.status === 'proposed'
        ? <div className="flex flex-wrap gap-2">
          <Button id="acceptBtn" className="font-semibold" onClick={() => void decide('accept')}>Accept as new HEAD</Button>
          <Button id="refineBtn" variant="outline" onClick={refine}>Refine from this</Button>
          <Button id="discardBtn" variant="destructive" onClick={() => void decide('discard')}>Discard</Button>
        </div>
        : null}
    </>
  );
}

export function Review() {
  const v = useStore(viewV), r = useStore((s) => s.lastResult);
  const showResult = !!r?.result && ['question', 'blocked', 'invalid'].includes(r.result.kind) && r.versionId === v.id;
  const showProposal = !showResult && v.origin === 'agent';
  const border = showProposal && v.status === 'proposed' ? 'border-warn' : showResult ? 'border-warn' : 'border-border';
  return (
    <section id="review" hidden={!showResult && !showProposal} aria-labelledby="h-review"
      className={`grid gap-2 rounded-lg border p-2.5 [&_h3]:m-0 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-muted-foreground ${border}`}>
      <h2 id="h-review" className="sr-only">Review</h2>
      {showResult ? <JobResultPanel r={r!} /> : showProposal ? <ProposalPanel key={v.id} v={v} /> : null}
    </section>
  );
}
