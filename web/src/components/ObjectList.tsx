// Objects of the viewed scene, selectable by keyboard. At most OBJECT_CAP rows; #objectMore says how many more.
import { useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { visibleObjects } from '../lib/review-model.ts';
import { toggleSel, useStore, viewV } from '../store.ts';
import { Errs } from './Panels.tsx';
import { QuickEdit } from './QuickEdit.tsx';

const OBJECT_CAP = 200;

export function ObjectList() {
  const [filterRaw, setFilter] = useState('');
  const v = useStore(viewV), selection = useStore((s) => s.selection);
  const filter = filterRaw.trim().toLowerCase();
  // An object selected past the cap is listed first (#46) and stays listed, also once deselected, until the version or
  // the filter changes: a row does not vanish under the pointer.
  const pins = useRef({ base: '', names: new Set<string>() });
  const base = `${v.id}\n${filter}`;
  if (pins.current.base !== base) pins.current = { base, names: new Set() };
  for (const s of selection) pins.current.names.add(s);
  const { shown, rest, matches } = visibleObjects(v.scene.nodes, filter, pins.current.names, OBJECT_CAP);
  return (
    <section aria-labelledby="h-objects">
      <h2 id="h-objects">Objects</h2>
      <Input type="search" id="objectFilter" className="mb-1.5 h-7" placeholder="Filter by name" aria-label="Filter objects by name" autoComplete="off"
        value={filterRaw} onChange={(e) => setFilter(e.target.value)} />
      <ul id="objectList" className="grid grid-cols-2 gap-0.75">
        {shown.map((n) => {
          const sel = selection.has(n.name);
          return (
            <li key={n.name} data-name={n.name}>
              <Label className={`rounded-md border px-1.5 py-1 font-normal ${sel ? 'sel border-primary bg-primary/10' : ''}`}>
                <Checkbox checked={sel} onCheckedChange={() => toggleSel(n.name, true)} />
                <span className="min-w-0 truncate">{n.name}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground">{n.type}{n.type === 'light' ? ` ${n.shape}` : ''}</span>
              </Label>
            </li>
          );
        })}
      </ul>
      <p id="objectMore" className="hint" hidden={matches ? rest <= 0 : !filter}>{matches ? `${rest} more — type to filter` : 'No objects match'}</p>
      <QuickEdit />
      <Errs scope="edit" />
    </section>
  );
}
