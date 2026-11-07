// Page layout (index.html, style.css:21-24 and 114-117): versions | render | direction; one column at 1100px and below.
import { TooltipProvider } from '@/components/ui/tooltip';
import { AskForm } from './components/AskForm.tsx';
import { AdoptDialog, FinalDialog } from './components/Dialogs.tsx';
import { Header } from './components/Header.tsx';
import { ObjectList } from './components/ObjectList.tsx';
import { AdoptionList, AuditLog, FinalRender, JobBox } from './components/Panels.tsx';
import { Review } from './components/Review.tsx';
import { Measure, StageBar } from './components/StageBar.tsx';
import { VersionList } from './components/VersionList.tsx';
import { Viewport } from './components/Viewport.tsx';

/** Live regions: written directly by say() and alertMsg() in store.ts, never rendered with children. */
function LiveRegions() {
  return <><div id="live" className="sr-only" aria-live="polite" /><div id="alert" className="sr-only" role="alert" /></>;
}

export function App() {
  return (
    <TooltipProvider>
      <Header />
      <main className="grid h-[calc(100vh-43px)] grid-cols-[240px_minmax(0,1fr)_360px] max-[1100px]:h-auto max-[1100px]:grid-cols-1">
        <aside aria-labelledby="h-versions" className="overflow-auto border-r bg-card p-3.5 max-[1100px]:border-t max-[1100px]:border-r-0">
          <h2 id="h-versions">Versions</h2>
          <p className="hint">Every change is a version. Proposals stay separate until you accept them.</p>
          <VersionList />
        </aside>
        <section aria-labelledby="h-stage" className="flex min-w-0 flex-col overflow-auto p-3.5">
          <h2 id="h-stage" className="sr-only">Render</h2>
          <StageBar />
          <Viewport />
          <Measure />
          <p className="hint">Numbers above come from vork's render metadata, not from the agent.</p>
        </section>
        <aside aria-labelledby="h-direct" className="flex flex-col gap-4.5 overflow-auto border-l bg-card p-3.5 max-[1100px]:border-t max-[1100px]:border-l-0">
          <h2 id="h-direct" className="sr-only">Direction</h2>
          <ObjectList />
          <AdoptionList />
          <AskForm />
          <JobBox />
          <Review />
          <FinalRender />
          <AuditLog />
        </aside>
      </main>
      <FinalDialog />
      <AdoptDialog />
      <LiveRegions />
    </TooltipProvider>
  );
}

/** Shown instead of the app when this tab has no Director session (app.js:600-605). */
export function Unpaired({ message }: { message: string }) {
  return (
    <>
      <Header meta="not paired" />
      <main>
        <section role="alert" className="mx-auto my-20 max-w-160 px-4">
          <h2 className="text-lg tracking-normal text-foreground normal-case">This tab is not paired with Director</h2>
          <p>Director opens a paired tab by itself when it starts. Ask your agent to call <code>open_review_tab</code>, or run <code>node server.mts</code> in a terminal and open the one-time link it prints.</p>
          <p className="hint">{message}</p>
        </section>
      </main>
    </>
  );
}
