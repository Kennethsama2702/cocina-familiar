import { useMemo } from 'react';
import { MOM, Shift, State, WEEKDAYS_ES, addDays, addMonths, daysInMonth, firstOfMonth, formatLong, formatMonth, getShift, weekdayMon0 } from '../domain';
import { Icon, People, Who, cssVar } from './common';

export function describeShift(s: Shift | undefined, people: People, today: string): string {
  if (!s) return 'Sin turno';
  const n = (id: string) => people[id]?.name ?? id;
  const parts = [`${n(s.assignee)}`];
  if (s.kind === 'mom') parts.push('excepción de mamá');
  if (s.kind === 'cover') parts.push(`adelantado por un viaje (le tocaba a ${n(s.original)})`);
  if (s.kind === 'compensation') parts.push('recupera su turno');
  if (s.status === 'done') parts.push('realizada');
  if (s.status === 'skipped') parts.splice(0, 1, 'nadie cocinó (el turno pasó al día siguiente)');
  if (s.date < today) parts.push('día pasado');
  return parts.join(', ');
}

interface Props {
  month: string; // YYYY-MM-01
  state: State;
  people: People;
  today: string;
  canEdit: boolean;
  selected: string | null;
  onSelect: (date: string) => void;
  onMonth: (monthStart: string) => void;
}

export function Calendar({ month, state, people, today, canEdit, selected, onSelect, onMonth }: Props) {
  const cells = useMemo(() => {
    const offset = weekdayMon0(month);
    const total = Math.ceil((offset + daysInMonth(month)) / 7) * 7;
    const start = addDays(month, -offset);
    return Array.from({ length: total }, (_, i) => addDays(start, i));
  }, [month]);

  const absentOn = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of state.absences) {
      if (a.cancelled) continue;
      for (const d of cells) if (d >= a.start && d <= a.end) m.set(d, [...(m.get(d) ?? []), a.person]);
    }
    return m;
  }, [state.absences, cells]);

  const todayMonth = firstOfMonth(today);
  const rotation = state.order.map((id) => people[id]).filter(Boolean);
  const first = state.shifts[0]?.date;
  const last = state.shifts[state.shifts.length - 1]?.date;

  const cellFor = (d: string) => {
    const s = getShift(state, d);
    const inMonth = d.startsWith(month.slice(0, 7));
    const past = d < today;
    const tags = [] as { k: string; cls: string; text: string; icon?: 'heart' | 'swap' | 'plane' | 'check' }[];
    if (s?.kind === 'mom') tags.push({ k: 'mom', cls: 'mom', text: 'Excepción', icon: 'heart' });
    if (s?.kind === 'cover') {
      const lost = (absentOn.get(d) ?? []).includes(s.original);
      tags.push({ k: 'cov', cls: 'cover', text: lost ? `cubre a ${people[s.original]?.name ?? ''}` : 'adelantado', icon: 'swap' });
    }
    if (s?.kind === 'compensation') tags.push({ k: 'cmp', cls: 'comp', text: 'Recupera', icon: 'swap' });
    if (s?.kind === 'manual') tags.push({ k: 'man', cls: 'cover', text: s.assignee === 'mom' ? `cubre a ${people[s.original]?.name ?? ''}` : `era ${people[s.original]?.name ?? ''}`, icon: 'swap' });
    if (s?.generatesComp) tags.push({ k: 'gen', cls: 'comp', text: 'Debe compensar' });
    if (s?.status === 'done') tags.push({ k: 'done', cls: 'done', text: 'Hecha', icon: 'check' });
    if (s?.morningBy) tags.push({ k: 'morn', cls: 'done', text: `Mañana: ${people[s.morningBy]?.name ?? ''}`, icon: 'check' });
    if (s?.status === 'skipped') tags.push({ k: 'skip', cls: 'skip', text: 'Nadie cocinó' });
    // Para no saturar, la etiqueta "fuera" solo aparece el primer día de la ausencia y cada lunes.
    for (const p of absentOn.get(d) ?? []) {
      const startsHere = state.absences.some((a) => !a.cancelled && a.person === p && a.start === d);
      if (startsHere || weekdayMon0(d) === 0) tags.push({ k: `away-${p}`, cls: 'away', text: `${people[p]?.name ?? ''} fuera`, icon: 'plane' });
    }
    return { s, inMonth, past, tags };
  };

  return (
    <section className="card flush" aria-label="Calendario mensual">
      <div className="cal-head">
        <h2 className="cal-title" aria-live="polite">{formatMonth(month)}</h2>
        <button className="btn icon" onClick={() => onMonth(addMonths(month, -1))} aria-label="Mes anterior" disabled={!!first && addDays(month, -1) < first}><Icon name="chev-l" /></button>
        <button className="btn" onClick={() => onMonth(todayMonth)} disabled={month === todayMonth}>Hoy</button>
        <button className="btn icon" onClick={() => onMonth(addMonths(month, 1))} aria-label="Mes siguiente" disabled={!!last && addMonths(month, 1) > last}><Icon name="chev-r" /></button>
      </div>

      <div className="cal-grid" role="grid" aria-label={formatMonth(month)}>
        {WEEKDAYS_ES.map((w) => <div key={w} className="cal-dow" role="columnheader">{w}</div>)}
        {cells.map((d) => {
          const { s, inMonth, past, tags } = cellFor(d);
          const interactive = !!s && (canEdit || true);
          const editable = canEdit && !!s && !past;
          return (
            <button
              key={d}
              role="gridcell"
              className={`cal-cell${inMonth ? '' : ' out'}${past ? ' past' : ''}${d === today ? ' today' : ''}${editable ? ' can' : ''}${selected === d ? ' sel' : ''}`}
              onClick={() => interactive && onSelect(d)}
              disabled={!interactive}
              aria-label={`${formatLong(d)}: ${describeShift(s, people, today)}`}
              aria-current={d === today ? 'date' : undefined}
              aria-disabled={past ? true : undefined}
            >
              <span className="num">{Number(d.slice(8))}</span>
              {s && (s.status === 'skipped'
                ? <span className="who skipped"><span className="name">Sin cocina</span><span className="ini" aria-hidden="true">–</span></span>
                : <Who person={people[s.assignee]} />)}
              {tags.length > 0 && (
                <span className="meta">
                  {tags.map((t) => (
                    <span key={t.k} className={`tag ${t.cls}`}>{t.icon && <Icon name={t.icon} size={11} />}{t.text}</span>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Móvil: agenda legible con nombres completos */}
      <div className="agenda" aria-label="Agenda del mes">
        {cells.filter((d) => d.startsWith(month.slice(0, 7))).map((d) => {
          const s = getShift(state, d);
          if (!s) return null;
          const past = d < today;
          return (
            <button key={d} className={`agenda-item${past ? ' past' : ''}${d === today ? ' today' : ''}`} onClick={() => onSelect(d)}>
              <span className="d">{formatShortDay(d)}</span>
              <span className="grow">{s.status === 'skipped' ? <span className="who skipped"><span className="name">Sin cocina</span></span> : <Who person={people[s.assignee]} />}</span>
              <span className="muted small">{s.kind === 'mom' ? 'Excepción' : s.kind === 'cover' ? 'Adelantado' : s.kind === 'compensation' ? 'Recupera' : s.status === 'done' ? 'Hecha' : ''}</span>
            </button>
          );
        })}
      </div>

      <div className="legend" aria-label="Leyenda">
        {rotation.map((p) => <span key={p!.id} className="legend-item" style={cssVar(p!.color)}><i />{p!.name}</span>)}
        {people[MOM] && <span className="legend-item" style={cssVar(people[MOM]!.color)}><i />{people[MOM]!.name} (excepción)</span>}
        <span className="legend-item muted"><Icon name="swap" size={13} /> cubre / compensa</span>
        <span className="legend-item muted"><Icon name="plane" size={13} /> ausente</span>
      </div>
    </section>
  );
}

function formatShortDay(d: string): string {
  const w = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'][weekdayMon0(d)];
  return `${w} ${Number(d.slice(8))}`;
}
