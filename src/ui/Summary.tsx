import { MOM, addDays, compViews, computeStats, formatShort, getShift, nextShiftOf, upcomingAbsences } from '../domain';
import { Snapshot } from '../data/repository';
import { Avatar, People, cssVar } from './common';

export function Summary({ snap, people }: { snap: Snapshot; people: People }) {
  const { state, today } = snap;
  const ctx = { today };
  const stats = computeStats(state, ctx);
  const todayShift = getShift(state, today);
  const tomorrow = getShift(state, addDays(today, 1));
  const absences = upcomingAbsences(state, ctx).slice(0, 4);
  const comps = compViews(state).filter((c) => c.status === 'pending' || c.status === 'scheduled');
  const pending = comps.filter((c) => c.status === 'pending');
  const max = Math.max(1, ...state.order.map((id) => stats[id]?.done ?? 0));
  const n = (id: string) => people[id]?.name ?? id;

  return (
    <aside className="side" aria-label="Resumen">
      <div className="card stack">
        <h2>Ahora</h2>
        {todayShift && (
          <div className="next-big" style={cssVar(people[todayShift.assignee]?.color ?? '#999')}>
            <Avatar person={people[todayShift.assignee]} />
            <div>
              <div className="muted small">Hoy · {formatShort(today)}</div>
              <div style={{ fontWeight: 650, fontSize: '1.1rem' }}>{n(todayShift.assignee)}</div>
              {todayShift.status === 'done' && <div className="small muted">Hecha por {n(todayShift.performedBy ?? todayShift.assignee)}</div>}
            </div>
          </div>
        )}
        {tomorrow && (
          <div className="kv"><span className="muted">Mañana</span><strong>{n(tomorrow.assignee)}{tomorrow.kind === 'mom' ? ' (excepción)' : ''}</strong></div>
        )}
        <div>
          <div className="muted small" style={{ marginBottom: 4 }}>Próximo turno de cada uno</div>
          {state.order.map((id) => {
            const s = nextShiftOf(state, id, ctx);
            return <div key={id} className="kv"><span>{n(id)}</span><span className="muted">{s ? (s.date === today ? 'Hoy' : formatShort(s.date)) : '—'}</span></div>;
          })}
          {(() => { const s = nextShiftOf(state, MOM, ctx); return s ? <div className="kv"><span>{n(MOM)}</span><span className="muted">{formatShort(s.date)}</span></div> : null; })()}
        </div>
      </div>

      <div className="card stack">
        <h2>Ausencias y compensaciones</h2>
        {absences.length === 0 ? <p className="muted small">No hay ausencias programadas.</p> : absences.map((a) => (
          <div key={a.id} className="kv"><span>{n(a.person)}</span><span className="muted">{formatShort(a.start)}{a.end !== a.start ? ` – ${formatShort(a.end)}` : ''}</span></div>
        ))}
        <div className="kv"><span className="muted">Compensaciones pendientes</span><strong>{pending.length}</strong></div>
        {comps.length > 0 && <div className="muted small">{comps.slice(0, 3).map((c) => `${n(c.debtor)} → ${n(c.creditor)}`).join(' · ')}</div>}
      </div>

      <div className="card stack">
        <h2>Tareas realizadas</h2>
        <div className="mini-bars">
          {state.order.map((id) => (
            <div key={id} className="bar-row" style={cssVar(people[id]?.color ?? '#999')}>
              <span>{n(id)}</span>
              <div className="bar-track" role="img" aria-label={`${n(id)}: ${stats[id]?.done ?? 0} tareas realizadas`}><div className="bar-fill" style={{ width: `${((stats[id]?.done ?? 0) / max) * 100}%` }} /></div>
              <strong>{stats[id]?.done ?? 0}</strong>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
