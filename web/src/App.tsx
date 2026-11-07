// Page layout: versions | render | inspector of the version on screen (#56); at 1100px and below the render stays on
// top and the two panels below it are tabs (#60). Layout classes are in index.css.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { AskForm } from './components/AskForm.tsx';
import { AdoptDialog } from './components/Dialogs.tsx';
import { Header } from './components/Header.tsx';
import { InspectorHead } from './components/Inspector.tsx';
import { ObjectList } from './components/ObjectList.tsx';
import { AdoptionList, AuditLog, Conn, Errs, JobBox, PaneTabs, UndoBar } from './components/Panels.tsx';
import { Review } from './components/Review.tsx';
import { Measure, StageBar } from './components/StageBar.tsx';
import { VersionList } from './components/VersionList.tsx';
import { Viewport } from './components/Viewport.tsx';
import { useStore } from './store.ts';

export function App() {
  const pane = useStore((s) => s.pane);
  return (
    <>
      <Header />
      <Conn />
      <main className="layout" data-pane={pane}>
        {/* Versions: what needs a decision, every version, and the history */}
        <aside className="panel versions" id="versions" aria-labelledby="h-versions">
          <AdoptionList />
          <Errs scope="adopt" />
          <h2 id="h-versions">Versions</h2>
          <p className="hint">Every change is a version. Proposals stay separate until you accept them.</p>
          <VersionList />
          <AuditLog />
        </aside>
        <section className="stage" aria-labelledby="h-stage">
          <h2 id="h-stage" className="sr-only">Render</h2>
          <StageBar />
          <Errs scope="preview" />
          <Errs scope="view" />
          <Viewport />
          <Measure />
          <p className="hint">Numbers above come from vork's render metadata, not from the agent.</p>
        </section>
        <PaneTabs />
        {/* Its state and what can be done with it first, then what changed, then selection and what to send about it */}
        <aside className="panel inspector" id="inspector" aria-labelledby="h-insp">
          <InspectorHead />
          <JobBox />
          <Review />
          <ObjectList />
          <AskForm />
        </aside>
      </main>
      <AdoptDialog />
      <UndoBar />
      <div id="live" className="sr-only" aria-live="polite" />
    </>
  );
}

/** Shown instead of the app when this tab has no Director session. */
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

/**
 * A rendering error shows what happened and how to recover instead of a blank page. Director's state is on the server,
 * so reloading the tab loses nothing that was decided.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error(error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section role="alert" className="mx-auto my-20 max-w-160 px-4">
        <h2 className="text-lg tracking-normal text-foreground normal-case">The page stopped drawing</h2>
        <p>Nothing was lost: versions and decisions are kept by Director. Reload the tab to continue.</p>
        <p className="hint">{this.state.error.message}</p>
        <Button type="button" onClick={() => location.reload()}>Reload</Button>
      </section>
    );
  }
}
