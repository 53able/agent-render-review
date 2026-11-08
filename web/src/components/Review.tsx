// Reviewing a proposal: what the agent says against what actually changed in the scene, compared with HEAD or with the
// parent (#52). Large diffs collapse into groups (#37) named by their name stems (#47).
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { isColor, linToHex } from '../lib/color.ts';
import { checkClaims, describeNames, groupDiff, isWildcard, nameRuns } from '../lib/review-model.ts';
import type { Diff, Job, Version } from '../lib/types.ts';
import type { DiffBase } from '../store.ts';
import { V, baseOf, dismissResult, get, setBase, useStore, viewV } from '../store.ts';

const CAP = 200;
const CELL = 'px-1 py-0.5 align-top font-mono whitespace-normal break-all';

function Value({ v }: { v: unknown }) {
  if (v === undefined) return <span className="hint">—</span>;
  const s = JSON.stringify(v);
  return isColor(v)
    ? <><span className="mr-1 inline-block size-2.5 rounded-xs border border-white/20 align-[-1px]" style={{ background: linToHex(v) }} />{s}</>
    : <>{s}</>;
}

/** claim: '' (claimed by this proposal), 'inherited' (by an unaccepted version in between) or 'unclaimed'. */
function DiffRow({ d, claim }: { d: Diff; claim: string }) {
  return (
    <TableRow className={claim}>
      <TableCell className={CELL}>
        {d.node}{d.path ? `.${d.path}` : ''}
        {claim === 'unclaimed' ? <span className="font-sans text-warn"> ⚠ not mentioned</span> : claim === 'inherited' ? <span className="font-sans text-muted-foreground"> (claimed by an earlier proposal)</span> : null}
      </TableCell>
      <TableCell className={CELL}><Value v={d.before} /></TableCell>
      <TableCell className={CELL}><Value v={d.after} /></TableCell>
    </TableRow>
  );
}

const unclaimedNote = (ds: Diff[], isClaimed: (d: Diff) => boolean) => {
  const u = ds.filter((d) => !isClaimed(d)).length;
  return u ? <span className="text-warn"> · ⚠ {u} not mentioned</span> : null;
};

/**
 * What a "prefix*" claim covers, by name stem: "→ 401 nodes: b0 … b399 (400), backdrop". Names of more than one stem
 * are flagged, because a short prefix can hide an unrelated change among the claimed ones (#47).
 */
function WildNote({ names }: { names: string[] }) {
  const mixed = nameRuns(names).length > 1;
  return <span className={mixed ? 'text-warn' : 'hint'}> → {names.length} node{names.length === 1 ? '' : 's'}{names.length ? `: ${describeNames(names)}` : ''}{mixed ? ' · check each name' : ''}</span>;
}

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
        // role=status: the job's end is already announced; this panel explains it without interrupting (review L-6).
        : <Alert variant="destructive" role="status">
          <AlertTitle>No version was created</AlertTitle>
          <AlertDescription>
            <p>{kind === 'blocked' ? 'The proposal broke a project rule enforced outside the model:' : 'vork rejected the scene twice. Last error:'}</p>
            <pre className="hint whitespace-pre-wrap">{kind === 'blocked' ? r.result.policy.blockers.join('\n') : r.result.log?.slice(-800)}</pre>
            <p className="hint">Your request is kept. Try rephrasing, narrowing the selection, or edit directly.</p>
          </AlertDescription>
        </Alert>}
      <div className="btnrow"><Button variant="outline" size="sm" id="dismiss" onClick={dismissResult}>Dismiss</Button></div>
    </>
  );
}

/** Keyed by version and base: which groups are open and whether the remaining rows are shown survive poll re-renders. */
function ProposalPanel({ v, head, baseKind, baseChoice, baseId }: { v: Version; head: string; baseKind: DiffBase; baseChoice: boolean; baseId: string | null }) {
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [shownMore, setShownMore] = useState(false);
  const s = get();
  const p = v.proposal;
  const diff = baseKind === 'head' ? (v.headDiff ?? []) : v.diff;
  const parent = V(v.parent, s);
  // Against HEAD, the claims of the unaccepted versions in between count too: they describe changes this one carries.
  const between: Version[] = [];
  for (let a = parent; baseKind === 'head' && a && a.id !== head && a.status !== 'accepted'; a = V(a.parent, s)) between.push(a);
  const own = checkClaims(p.claimed_changes, diff);
  const all = checkClaims([...p.claimed_changes, ...between.flatMap((a) => a.proposal?.claimed_changes || [])], diff);
  const claimOf = (d: Diff) => (own.isClaimed(d) ? '' : all.isClaimed(d) ? 'inherited' : 'unclaimed');
  const typeOf = new Map([...(V(baseId, s)?.scene.nodes || []), ...v.scene.nodes].map((n) => [n.name, n.type]));
  const { groups, rest } = groupDiff(diff, typeOf);
  const hidden = rest.slice(CAP);
  const shown = shownMore ? rest : rest.slice(0, CAP);
  const head_ = 'h-auto px-1 py-0.5 text-muted-foreground';
  return (
    <>
      {baseChoice
        ? <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-xs text-muted-foreground">Changes against</span>
            <RadioGroup value={baseKind} onValueChange={(k) => setBase(v.id, k as DiffBase)} aria-label="Changes against" className="flex w-auto flex-wrap gap-x-3 gap-y-1">
              <Label className="font-normal"><RadioGroupItem value="head" /> HEAD {head} <span className="hint my-0">(what accepting changes)</span></Label>
              <Label className="font-normal"><RadioGroupItem value="parent" /> parent {v.parent} <span className="hint my-0">(this step only)</span></Label>
            </RadioGroup>
          </div>
          {baseKind === 'head'
            ? (between.length ? <p className="hint">Includes the changes of {between.map((a) => a.id).join(', ')} ({parent?.status}), which accepting this also accepts; their claims count below.</p> : null)
            : <p className="text-warn">⚠ Built on {v.parent}, which is {parent?.status}. Accepting this also accepts that version's changes, not shown here. <Button type="button" variant="outline" size="xs" id="showHeadDiff" onClick={() => setBase(v.id, 'head')}>Show changes against HEAD</Button></p>}
        </>
        : null}
      <div><h3>Request</h3>{v.instruction}</div>
      <div>
        <h3>Agent's reading</h3><p className="text-sm">{p.interpretation}</p>
        {p.assumptions.length ? <ul className="list-disc pl-4.5">{p.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
      </div>
      <div>
        <h3>What the agent says it changed</h3>
        <ul className="list-disc pl-4.5">
          {p.claimed_changes.map((c, i) => (
            <li key={i}><b>{c.node}</b>{isWildcard(c.node) ? <WildNote names={own.wildMatches.get(c.node) || []} /> : null}: {c.what} <span className="hint">— {c.why}</span></li>
          ))}
        </ul>
      </div>
      <div>
        <h3>What actually changed (computed from the scene)</h3>
        <Table className="difftable text-[11.5px]">
          <TableHeader><TableRow><TableHead className={head_}>node.field</TableHead><TableHead className={head_}>before</TableHead><TableHead className={head_}>after</TableHead></TableRow></TableHeader>
          <TableBody>
            {groups.map(({ type, kind, ds }, i) => (
              <TableRow key={`g${i}`} className="group">
                <TableCell colSpan={3} className="px-1 py-0.5 whitespace-normal">
                  {/* rows inside a group are built only when the human opens it */}
                  <Collapsible data-group={i} open={open.has(i)}
                    onOpenChange={(o) => setOpen((prev) => { const n = new Set(prev); if (o) n.add(i); else n.delete(i); return n; })}>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="xs" className="h-auto px-1 text-left font-normal whitespace-normal">{`${ds.length} ${type} node${ds.length > 1 ? 's' : ''} ${kind}: ${describeNames(ds.map((d) => d.node))}`}{unclaimedNote(ds, all.isClaimed)}</Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <Table className="mt-1 text-[11.5px]"><TableBody>{ds.map((d, j) => <DiffRow key={j} d={d} claim={claimOf(d)} />)}</TableBody></Table>
                    </CollapsibleContent>
                  </Collapsible>
                </TableCell>
              </TableRow>
            ))}
            {shown.map((d, j) => <DiffRow key={`r${j}`} d={d} claim={claimOf(d)} />)}
            {hidden.length && !shownMore
              ? <TableRow className="group"><TableCell colSpan={3} className="px-1 py-0.5 whitespace-normal">
                <Button type="button" variant="outline" size="xs" id="moreDiff" onClick={() => setShownMore(true)}>Show remaining {hidden.length} rows</Button>{unclaimedNote(hidden, all.isClaimed)}
              </TableCell></TableRow>
              : null}
            {!groups.length && !rest.length ? <TableRow><TableCell colSpan={3}>No changes</TableCell></TableRow> : null}
          </TableBody>
        </Table>
        {own.ghost.length ? <p className="text-warn">⚠ Claimed but not changed: {own.ghost.join(', ')}</p> : null}
      </div>
      {p.policy.flags.length
        ? <div><h3>Needs attention</h3><ul className="list-disc pl-4.5">{p.policy.flags.map((f, i) => <li key={i} className="text-warn">{f.level}: {f.msg}</li>)}</ul></div>
        : null}
      <Collapsible>
        <CollapsibleTrigger asChild><Button variant="link" size="xs" className="hint px-0">Context that was sent</Button></CollapsibleTrigger>
        <CollapsibleContent><pre className="hint whitespace-pre-wrap">{p.context.join('\n\n') || 'scene only'}</pre></CollapsibleContent>
      </Collapsible>
      <p className="hint">{p.via === 'mcp' ? 'Proposed by your ADE agent via MCP' : `Agent cost ${p.cost ? '$' + p.cost.toFixed(3) : 'n/a'}`}. Judge the image, not the explanation.</p>
    </>
  );
}

export function Review() {
  const v = useStore(viewV), r = useStore((s) => s.lastResult), head = useStore((s) => s.data.head);
  const baseKind = useStore((s) => baseOf(viewV(s), s).kind), baseChoice = useStore((s) => baseOf(viewV(s), s).choice), baseId = useStore((s) => baseOf(viewV(s), s).id);
  // failure / question states from the last agent job (not tied to a version)
  const showResult = !!r?.result && ['question', 'blocked', 'invalid'].includes(r.result.kind) && r.versionId === v.id;
  const showProposal = !showResult && v.origin === 'agent';
  return (
    <section id="review" hidden={!showResult && !showProposal} aria-label="What this proposal changes"
      className="grid gap-2 rounded-lg border p-2.5 [&_h3]:m-0 [&_h3]:text-xs [&_h3]:font-semibold [&_h3]:text-muted-foreground">
      {showResult ? <JobResultPanel r={r!} />
        : showProposal ? <ProposalPanel key={`${v.id}:${baseKind}`} v={v} head={head} baseKind={baseKind} baseChoice={baseChoice} baseId={baseId} /> : null}
    </section>
  );
}
