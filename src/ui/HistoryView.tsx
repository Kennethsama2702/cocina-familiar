import { useMemo, useState } from 'react';
import { effectivePerformer, formatShort } from '../domain';
import { Snapshot } from '../data/repository';
import { People } from './common';

type Filter = 'all' | 'changes' | 'mom' | 'cover' | 'comp';
const FILTERS: [Filter, string][] = [['all', 'Todo'], ['changes', 'Con cambios'], ['mom', 'Mamá'], ['cover', 'Viajes'], ['comp', 'Compensaciones']];

export function HistoryView({ snap, people, admin }: { snap: Snapshot; people: People; admin: boolean }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(60);
  const n = (id: string | null) => (id ? people[id]?.name ?? id : '—');
  const ctx = { today: snap.today };
  const showReason = admin || snap.settings.showReasons;

  const rows = useMemo(() => {
    const list = snap.state.shifts
      .filter((s) => s.date < snap.today || s.status !== 'scheduled')
      .filter((s) => s.date <= snap.today)
      .reverse();
    return list.filter((s) => {
      const who = effectivePerformer(s, ctx);
      switch (filter) {
        case 'changes': return who !== s.original || s.kind !== 'rotation';
        case 'mom': return s.kind === 'mom';
        case 'cover': return s.kind === 'cover' || s.kind === 'compensation' || (who !== s.original && s.original !== 'mom');
        case 'comp': return !!s.generatesComp || !!s.settlesComp || s.kind === 'compensation';
        default: return true;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, filter]);

  const compById = new Map(snap.state.comps.map((c) => [c.id, c]));

  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between wrap">
          <h2>Historial de tareas</h2>
          <div className="filters" role="group" aria-label="Filtro">
            {FILTERS.map(([k, label]) => <button key={k} className="chip-btn" aria-pressed={filter === k} onClick={() => { setFilter(k); setLimit(60); }}>{label}</button>)}
          </div>
        </div>
        {rows.length === 0 ? <p className="muted">Todavía no hay registros que mostrar.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fecha</th><th>Asignado originalmente</th><th>Realizó</th><th>Detalle</th></tr></thead>
              <tbody>
                {rows.slice(0, limit).map((s) => {
                  const who = effectivePerformer(s, ctx);
                  const details: string[] = [];
                  if (s.kind === 'mom') details.push('Excepción de mamá');
                  if (s.kind === 'cover') details.push(`Adelantado por un viaje (le tocaba a ${n(s.original)})`);
                  if (s.kind === 'manual') details.push('Cambio manual');
                  if (s.kind === 'compensation') details.push('Recupera su turno');
                  if (s.generatesComp) { const c = compById.get(s.generatesComp); if (c) details.push(`Compensación ${c.status === 'done' ? 'realizada' : c.status === 'cancelled' ? 'cancelada' : 'pendiente'}`); }
                  if (s.status === 'skipped') details.push('Nadie cocinó: el turno pasó al día siguiente');
                  if (s.status === 'scheduled') details.push('Sin registro: se da por hecha');
                  if (s.status === 'done' && s.performedBy !== s.assignee) details.push(`Asignada a ${n(s.assignee)}`);
                  if (showReason && s.reason) details.push(`“${s.reason}”`);
                  return (
                    <tr key={s.date}>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatShort(s.date)}</td>
                      <td>{n(s.original)}</td>
                      <td>{who ? n(who) : <span className="muted">—</span>}</td>
                      <td className="muted small">{details.join(' · ') || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length > limit && <button className="btn" onClick={() => setLimit(limit + 60)}>Ver más</button>}
      </section>

      <section className="card stack">
        <h2>Registro de cambios</h2>
        {snap.changes.length === 0 ? <p className="muted">Sin cambios registrados.</p> : (
          <div className="list">
            {snap.changes.slice(0, 80).map((c) => (
              <div key={c.id} className="list-item">
                <div className="grow">
                  <div>{c.summary}</div>
                  {showReason && c.reason && <div className="muted small">Motivo: {c.reason}</div>}
                  {c.affected_count > 0 && <div className="muted small">{c.affected_count} asignación(es) afectada(s)</div>}
                </div>
                <span className="muted small" style={{ whiteSpace: 'nowrap' }}>{new Date(c.created_at).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'short' })}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
