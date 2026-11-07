import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, Unpaired } from './App.tsx';
import { load, renderMissingDraft, startPolling } from './store.ts';
import './index.css';

// Follow the OS colour scheme without a reload (index.html sets the initial class before first paint).
const dark = matchMedia('(prefers-color-scheme: dark)');
dark.addEventListener('change', (e) => document.documentElement.classList.toggle('dark', e.matches));

// Pair this tab with Director using the one-time link Director opened. The token leaves the address bar (and the
// history entry) before it is sent, so a slow or failed request does not leave it there.
// Done once here, before the first render: an effect would run twice under StrictMode.
const pairMatch = location.hash.match(/^#pair=([0-9a-f]+)$/);
if (pairMatch) {
  history.replaceState(null, '', location.pathname + location.search);
  await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: pairMatch[1] }) });
}
let unpaired: string | null = null;
try { await load({ keepView: false }); }
catch (e) { unpaired = (e as Error).message; }

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
createRoot(root).render(<StrictMode>{unpaired === null ? <App /> : <Unpaired message={unpaired} />}</StrictMode>);
if (unpaired === null) { startPolling(); void renderMissingDraft(); }
