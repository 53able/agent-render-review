/** Same fetch semantics as public/app.js: POST JSON when a body is given, same-origin default credentials, 202 counts as success, server `error` becomes the message. */
export const api = async <T = any>(url: string, body?: unknown): Promise<T> => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
};
