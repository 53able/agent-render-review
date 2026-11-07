// Objects of the viewed scene, selectable by keyboard (app.js:319-345). At most OBJECT_CAP rows; #objectMore says how many more.
import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toggleSel, useStore, viewV } from '../store.ts';
import { QuickEdit } from './QuickEdit.tsx';

const OBJECT_CAP = 200;

export function ObjectList() {
  const [filterRaw, setFilter] = useState('');
  const v = useStore(viewV), selection = useStore((s) => s.selection);
  const filter = filterRaw.trim().toLowerCase();
  const matches = v.scene.nodes.filter((n) => n.name && n.name.toLowerCase().includes(filter));
  const rest = matches.length - OBJECT_CAP;
  return (
    <section aria-labelledby="h-objects">
      <h2 id="h-objects">Objects</h2>
      <Input type="search" id="objectFilter" className="mb-1.5 h-7" placeholder="Filter by name" aria-label="Filter objects by name" autoComplete="off"
        value={filterRaw} onChange={(e) => setFilter(e.target.value)} />
      <ul id="objectList" className="grid grid-cols-2 gap-0.75">
        {matches.slice(0, OBJECT_CAP).map((n) => {
          const sel = selection.has(n.name);
          return (
            <li key={n.name} data-name={n.name}>
              <Label className={`rounded-md border px-1.5 py-1 font-normal ${sel ? 'border-primary bg-primary/10' : ''}`}>
                <Checkbox checked={sel} onCheckedChange={() => toggleSel(n.name, true)} />
                <span className="min-w-0 truncate">{n.name}</span>
                <span className="ml-auto text-[10.5px] text-muted-foreground">{n.type}{n.type === 'light' ? ` ${n.shape}` : ''}</span>
              </Label>
            </li>
          );
        })}
      </ul>
      <p id="objectMore" className="hint" hidden={matches.length ? rest <= 0 : !filter}>{matches.length ? `${rest} more — type to filter` : 'No objects match'}</p>
      <QuickEdit />
    </section>
  );
}
