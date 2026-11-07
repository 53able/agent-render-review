import type { Data } from './types.ts';

/** Changes exactly when something the page shows from the polled state changes. */
export const signature = (d: Data): string => JSON.stringify([d.head, d.versions.length, d.versions.map((v) => v.status + Object.keys(v.renders).join()), d.adoptionRequests.map((a) => a.status), d.events.length, d.agentCursor]);
