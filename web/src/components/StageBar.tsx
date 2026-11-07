// Above the viewport: render quality, compare (with the reason when it cannot apply), the page preview toggle (ADE),
// one line that says what is shown (#59), and the fixed notice of a new agent proposal (View is its first button).
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { State } from '../store.ts';
import { V, baseOf, closeNotice, isADE, rerender, setCompare, setOnPage, setProfile, useStore, viewNotice, viewV } from '../store.ts';

const PROFILES = ['draft', 'previs', 'final'];

/** What the compare base is, why compare cannot be used (or ''), and what the viewport shows. */
function viewState(s: State): { base: string; noCompare: string; viewing: string } {
  const v = viewV(s); const base = baseOf(v, s); const pr = V(base.id, s)?.renders[s.profile];
  const noCompare = s.onPage ? 'not on page: the page shows one candidate' : !base.id ? `${v.id} has no parent` : !pr ? `${base.id} has no ${s.profile} render` : '';
  const shown = s.onPage
    ? `${v.renders[s.profile] ? s.profile : 'draft'} on page ${s.data.config.pageUrl || '(no pageUrl)'}`
    : `${s.profile}${s.compare && !noCompare ? ` · wipe: ◀ ${base.id} | ${v.id} ▶` : ''}`;
  return {
    base: base.kind === 'head' ? `HEAD (${base.id})` : 'parent',
    noCompare,
    viewing: `Showing ${v.id} · ${v.status}${v.id === s.data.head ? ' · HEAD' : v.status === 'accepted' ? ' (not HEAD)' : ''} · ${shown} · scene ${v.hash}`,
  };
}

export function ProfileSwitch() {
  const profile = useStore((s) => s.profile);
  // An empty value (the selected item clicked again) keeps the current profile without drawing again.
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={profile} role="radiogroup" aria-label="Render quality shown"
      onValueChange={(p) => { if (p) setProfile(p); }}>
      {PROFILES.map((p) => <ToggleGroupItem key={p} value={p} data-profile={p} className="px-2.5">{p}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}

function Notice() {
  const notice = useStore((s) => s.notice);
  return (
    <Alert id="notice" role="status" hidden={!notice}
      className="fixed top-[52px] right-4 z-10 flex w-auto max-w-[calc(100vw-32px)] items-center gap-2.5 border-agent shadow-lg">
      <span>New proposal <b>{notice}</b> from your agent</span>
      <Button type="button" variant="outline" size="sm" onClick={viewNotice}>View</Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={closeNotice}>✕</Button>
    </Alert>
  );
}

export function StageBar() {
  const compare = useStore((s) => s.compare), onPage = useStore((s) => s.onPage), ade = useStore(isADE);
  const base = useStore((s) => viewState(s).base), noCompare = useStore((s) => viewState(s).noCompare), viewing = useStore((s) => viewState(s).viewing);
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-3.5">
      <ProfileSwitch />
      <Label className="font-normal">
        <Checkbox id="compareToggle" checked={compare} disabled={!!noCompare} aria-describedby="compareWhy" onCheckedChange={(c) => setCompare(c === true)} />
        Compare with <span id="compareBase">{base}</span> <span id="compareWhy" className="hint my-0">{noCompare ? `(${noCompare})` : ''}</span>
      </Label>
      <Toggle id="pageBtn" variant="outline" size="sm" hidden={!ade} pressed={onPage} onPressedChange={setOnPage}
        className="aria-pressed:border-primary aria-pressed:text-primary">On page</Toggle>
      <span id="viewing" className="ml-auto font-mono text-[11px] text-muted-foreground">{viewing}</span>
      <Notice />
    </div>
  );
}

export function Measure() {
  const m = useStore((s) => s.measure);
  const rows: [string, string | number, boolean?][] = [];
  if (m?.kind === 'render') {
    const { r } = m; const e = r.exposure; const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    rows.push(['render', `${r.profile} · ${r.seconds.toFixed(2)}s`], ['integrator', `${r.settings.integrator} · ${r.settings.samples} spp`],
      ['mean', e.mean.toFixed(3)], ['clipped', pct(e.clipped), e.clipped > 0.01], ['near-black', pct(e.near_black), e.near_black > 0.05],
      ['warnings', r.warnings.length, r.warnings.length > 0]);
  } else if (m?.kind === 'page') {
    rows.push(['page', m.pageUrl ?? ''], ['substituted requests', m.pv.matched, !m.pv.matched]);
  }
  return (
    <dl id="measure" aria-label="Measurements reported by vork" className="measure mt-2.5 flex flex-wrap gap-x-4.5 gap-y-1 text-xs">
      {rows.map(([k, v, warn]) => (
        <div key={k} className="flex gap-1.5"><dt className="text-muted-foreground">{k}</dt><dd className={`font-mono ${warn ? 'text-warn' : ''}`}>{v}</dd></div>
      ))}
      {m?.kind === 'page' && m.pv.warning ? <div className="flex gap-1.5"><dd className="text-warn">{m.pv.warning}</dd></div> : null}
      {/* ids is null for a render recorded before object ids were hashed: Director does not serve that file (#43). */}
      {m?.kind === 'render' && !m.r.ids
        ? <div className="flex gap-1.5"><dd className="text-warn">Object ids of this render predate recorded hashes, so clicking cannot select. {m.r.profile === 'final'
          ? 'Plan the final render again to fix it.'
          : <Button type="button" variant="outline" size="xs" id="rerender" onClick={() => void rerender(m.r.profile)}>Render {m.r.profile} again</Button>}</dd></div>
        : null}
    </dl>
  );
}
