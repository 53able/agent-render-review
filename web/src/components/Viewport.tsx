// The render, its object-id overlay and the compare wipe (app.js:193-299). Canvases are drawn imperatively through refs;
// every colour inside the viewport comes from canvas-colors.ts so it does not follow the page theme.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { Slider } from '@/components/ui/slider';
import { api } from '../lib/api.ts';
import { canvasColors as C } from '../lib/canvas-colors.ts';
import { pick } from '../lib/ids.ts';
import type { Ids, PagePreview } from '../lib/types.ts';
import { NO_RENDER, V, alertMsg, cachePagePreview, clearSelection, get, say, set, toggleSel, useStore, viewV } from '../store.ts';

const loadImg = (src: string) => new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(`cannot load ${src}`)); i.src = src; });

type Gfx = { img: HTMLImageElement | null; imgB: HTMLImageElement | null; ids: Ids | null; hover: string | null; wipe: number; seq: number };

export function Viewport() {
  const cvRef = useRef<HTMLCanvasElement>(null), ovRef = useRef<HTMLCanvasElement>(null), vpRef = useRef<HTMLDivElement>(null);
  const g = useRef<Gfx>({ img: null, imgB: null, ids: null, hover: null, wipe: 50, seq: 0 });
  const [wipeVal, setWipeVal] = useState(50);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const drawSeq = useStore((s) => s.drawSeq), viewId = useStore((s) => s.viewId), selection = useStore((s) => s.selection);
  const empty = useStore((s) => s.empty), wipe = useStore((s) => s.wipe);

  const paintOverlay = useCallback(() => {
    const ov = ovRef.current; if (!ov) return; const octx = ov.getContext('2d')!;
    octx.clearRect(0, 0, ov.width, ov.height); const ids = g.current.ids; if (!ids) return;
    const { w, h, arr, objects } = ids; const img = octx.createImageData(w, h); const d = img.data;
    const selected = get().selection, hover = g.current.hover;
    const [sr, sg, sb] = C.overlaySelected, [hr, hg, hb] = C.overlayHover;
    for (let i = 0; i < arr.length; i++) {
      const name = objects[arr[i]!]; if (!name) continue;
      const sel = selected.has(name), hov = name === hover;
      if (!sel && !hov) continue;
      // edge test: draw a solid outline plus a light fill
      const x = i % w, y = (i / w) | 0;
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || arr[i - 1] !== arr[i] || arr[i + 1] !== arr[i] || arr[i - w] !== arr[i] || arr[i + w] !== arr[i];
      const o = i * 4;
      if (sel) { d[o] = sr; d[o + 1] = sg; d[o + 2] = sb; d[o + 3] = edge ? C.overlaySelectedAlpha.edge : C.overlaySelectedAlpha.fill; }
      else { d[o] = hr; d[o + 1] = hg; d[o + 2] = hb; d[o + 3] = edge ? C.overlayHoverAlpha.edge : C.overlayHoverAlpha.fill; }
    }
    octx.putImageData(img, 0, 0);
  }, []);

  const paint = useCallback(() => {
    const cv = cvRef.current, { img, imgB } = g.current; if (!cv || !img) return; const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0);
    if (imgB) {
      const v = viewV(); const x = Math.round(cv.width * g.current.wipe / 100);
      ctx.drawImage(imgB, 0, 0, x, cv.height, 0, 0, x, cv.height);
      ctx.fillStyle = C.wipeLine; ctx.fillRect(x - 1, 0, 2, cv.height);
      ctx.font = C.wipeFont; ctx.fillStyle = C.wipeLabel;
      ctx.fillText(`◀ ${v.parent}`, 10, 22); ctx.fillText(`${v.id} ▶`, cv.width - 70, 22);
    }
    paintOverlay();
  }, [paintOverlay]);

  // The real page with the candidate substituted (server-side headless Chrome; project files untouched).
  const drawPage = useCallback(async (seq: number) => {
    const cv = cvRef.current!, ov = ovRef.current!, vp = vpRef.current!;
    const stale = () => seq !== g.current.seq;
    delete cv.dataset.ready;
    const s = get(); const v = viewV(s); const prof = v.renders[s.profile] ? s.profile : 'draft'; const pageUrl = s.data.config.pageUrl;
    set({ viewing: `${v.id} · on page · ${pageUrl || 'no pageUrl'}`, wipe: false });
    ov.getContext('2d')!.clearRect(0, 0, ov.width, ov.height); g.current.ids = null; g.current.imgB = null;
    let pv = v.pagePreviews?.[prof];
    if (!pv) {
      set({ empty: 'Opening the page with this candidate…' });
      pv = await api<PagePreview>('/api/preview', { versionId: v.id, profile: prof }).catch((e: Error): PagePreview => ({ ok: false, reason: e.message, image: '', matched: 0 }));
      if (pv.ok) cachePagePreview(v.id, prof, pv);
      if (stale()) return;
    }
    if (!pv.ok) {
      // The reason stays on screen for 2.5 s, then the render comes back.
      set({ empty: `Page preview unavailable: ${pv.reason}. Showing render only.`, onPage: false });
      alertMsg(`Page preview unavailable: ${pv.reason}`);
      setTimeout(() => set({ empty: NO_RENDER, drawSeq: get().drawSeq + 1 }), 2500);
      return;
    }
    set({ empty: null });
    const img = await loadImg(pv.image); if (stale()) return;
    for (const c of [cv, ov]) { c.width = img.width; c.height = img.height; }
    vp.style.aspectRatio = `${img.width} / ${img.height}`;
    const ctx = cv.getContext('2d')!; ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0);
    set({ measure: { kind: 'page', pageUrl, pv } });
    if (pv.warning) say(pv.warning);
  }, []);

  const drawViewport = useCallback(async () => {
    const seq = ++g.current.seq; const stale = () => seq !== g.current.seq;
    if (get().onPage) return drawPage(seq);
    const cv = cvRef.current!, ov = ovRef.current!, vp = vpRef.current!;
    const s = get(); const v = viewV(s); const r = v.renders[s.profile];
    delete cv.dataset.ready; // clicks are ignored until this view's object ids are loaded
    set({
      viewing: `${v.id} · ${v.status}${v.status === 'accepted' && v.id !== s.data.head ? ' (not head)' : ''} · scene ${v.hash}`,
      empty: r ? null : NO_RENDER, measure: r ? { kind: 'render', r } : null,
    });
    if (!r) {
      cv.getContext('2d')!.clearRect(0, 0, cv.width, cv.height); ov.getContext('2d')!.clearRect(0, 0, ov.width, ov.height);
      g.current.ids = null; set({ wipe: false }); return;
    }
    const img = await loadImg(r.image); if (stale()) return;
    const pr = V(v.parent, s)?.renders[s.profile];
    const imgB = s.compare && pr ? await loadImg(pr.image) : null; if (stale()) return;
    set({ wipe: !!imgB });
    const buf = await (await fetch(r.ids)).arrayBuffer(); if (stale()) return;
    g.current.img = img; g.current.imgB = imgB;
    g.current.ids = { w: r.width, h: r.height, arr: new Uint16Array(buf), objects: Object.fromEntries(r.objects.map((o) => [o.pass_index, o.name])) };
    for (const c of [cv, ov]) { c.width = r.width; c.height = r.height; }
    vp.style.aspectRatio = `${r.width} / ${r.height}`;
    paint();
    cv.dataset.ready = `${v.id}:${s.profile}`;
  }, [drawPage, paint]);

  useEffect(() => {
    drawViewport().catch((e: Error) => alertMsg(`Cannot show the render: ${e.message}`));
  }, [drawSeq, viewId, drawViewport]);
  useEffect(() => { paintOverlay(); }, [selection, paintOverlay]);

  const pickAt = (ev: MouseEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    return pick(g.current.ids, ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height);
  };
  const onMove = (ev: MouseEvent<HTMLCanvasElement>) => {
    const n = pickAt(ev);
    if (n !== g.current.hover) { g.current.hover = n; paintOverlay(); }
    if (!n) { setTip(null); return; }
    const r = vpRef.current!.getBoundingClientRect();
    setTip({ x: ev.clientX - r.left, y: ev.clientY - r.top, text: n + (get().selection.has(n) ? ' · selected' : ' · click to select') });
  };
  const onLeave = () => { g.current.hover = null; setTip(null); paintOverlay(); };
  const onClick = (ev: MouseEvent<HTMLCanvasElement>) => {
    if (!cvRef.current?.dataset.ready) return;
    const n = pickAt(ev);
    if (!n) clearSelection(); else toggleSel(n, ev.shiftKey || ev.metaKey);
  };

  // The wipe track and thumb use fixed colours: the shadcn Slider reads --muted (track), --primary (range) and --ring
  // (thumb border), so they are overridden on its root.
  const wipeStyle = { '--muted': C.wipeTrack, '--primary': C.wipeThumb, '--ring': C.wipeThumb } as CSSProperties;
  return (
    <div id="viewport" ref={vpRef} className="relative aspect-video w-full overflow-hidden rounded-lg border" style={{ background: C.viewportBg }}>
      <canvas
        id="canvas" ref={cvRef} width={960} height={540} className="absolute inset-0 size-full cursor-crosshair"
        aria-label="Render. Hover to identify objects, click to select. Object list on the right offers the same selection by keyboard."
        onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick}
      />
      <canvas id="overlay" ref={ovRef} width={960} height={540} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
      <div
        id="tip" hidden={!tip} className="pointer-events-none absolute translate-x-2.5 translate-y-2.5 rounded border px-1.5 py-0.5 text-xs"
        style={{ left: tip?.x, top: tip?.y, color: C.tipFg, background: C.tipBg, borderColor: C.tipBorder }}
      >{tip?.text}</div>
      <Slider
        id="wipe" hidden={!wipe} min={0} max={100} value={[wipeVal]} aria-label="Compare wipe position"
        className="absolute inset-x-0 bottom-2 mx-auto w-3/5! **:data-[slot=slider-thumb]:bg-(--primary)" style={wipeStyle}
        onValueChange={([x]) => { const w = x ?? 50; setWipeVal(w); g.current.wipe = w; paint(); }}
      />
      <div id="empty" hidden={empty === null} className="absolute inset-0 grid place-items-center" style={{ color: C.emptyFg, background: C.emptyBg }}>{empty ?? NO_RENDER}</div>
    </div>
  );
}
