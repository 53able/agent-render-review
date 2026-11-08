// The top bar. In ADE mode only the project directory name is on screen (recordings, one-line header); the full path
// is in the title, shown on hover.
import { isADE, useStore } from '../store.ts';

export function Header({ meta: fixed }: { meta?: string }) {
  const data = useStore((s) => s.data), ade = useStore(isADE);
  const meta = fixed ?? (ade
    ? `${data.vork} · ADE mode · project ${data.project?.split(/[\\/]/).filter(Boolean).at(-1) ?? ''} · proposals come from your agent via MCP · local only`
    : `${data.vork} · agent: claude ${data.model} (no tools) · local only`);
  return (
    <header className="flex h-[43px] items-center justify-between gap-4 border-b px-4">
      <div className="flex flex-none items-center gap-2 font-semibold tracking-wide">
        <span aria-hidden="true" className="size-2.5 rounded-full bg-primary shadow-[0_0_12px_var(--primary)]" /> Render Director
      </div>
      <div id="meta" className="min-w-0 truncate text-xs text-muted-foreground" title={!fixed && ade ? data.project || '' : undefined}>{meta}</div>
    </header>
  );
}
