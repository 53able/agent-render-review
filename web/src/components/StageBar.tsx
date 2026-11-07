// Above the viewport: render quality, compare with parent, the page preview toggle (ADE), what is shown, and the
// fixed notice of a new agent proposal (View is its first button).
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { closeNotice, isADE, setCompare, setOnPage, setProfile, useStore, viewNotice } from '../store.ts';

const PROFILES = ['draft', 'previs', 'final'];

export function ProfileSwitch() {
  const profile = useStore((s) => s.profile);
  return (
    <ToggleGroup type="single" variant="outline" size="sm" spacing={0} value={profile} aria-label="Render quality shown"
      onValueChange={(p) => setProfile(p || profile)}>
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
  const compare = useStore((s) => s.compare), onPage = useStore((s) => s.onPage), ade = useStore(isADE), viewing = useStore((s) => s.viewing);
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-3.5">
      <ProfileSwitch />
      <Label className="font-normal">
        <Checkbox id="compareToggle" checked={compare} onCheckedChange={(c) => setCompare(c === true)} /> Compare with parent
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
    <dl id="measure" aria-label="Measurements reported by vork" className="mt-2.5 flex flex-wrap gap-x-4.5 gap-y-1 text-xs">
      {rows.map(([k, v, warn]) => (
        <div key={k} className="flex gap-1.5"><dt className="text-muted-foreground">{k}</dt><dd className={`font-mono ${warn ? 'text-warn' : ''}`}>{v}</dd></div>
      ))}
      {m?.kind === 'page' && m.pv.warning ? <div className="flex gap-1.5"><dd className="text-warn">{m.pv.warning}</dd></div> : null}
    </dl>
  );
}
