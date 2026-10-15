import { computeStats } from '../domain';
import { Snapshot } from '../data/repository';
import { Avatar, People, cssVar } from './common';

export function StatsView({ snap, people }: { snap: Snapshot; people: People }) {
  const stats = computeStats(snap.state, { today: snap.today });
  const max = Math.max(1, ...snap.state.order.map((id) => Math.max(stats[id]!.assigned, stats[id]!.done)));
  const totalDone = snap.state.order.reduce((n, id) => n + stats[id]!.done, 0);
  return (
    <section className="card stack">
      <div>
        <h2>Estadísticas por persona</h2>
        <p className="muted small">La barra clara son las tareas asignadas originalmente; la barra sólida, las realmente realizadas. Una tarea reasignada cuenta una sola vez, para quien la hizo.</p>
      </div>
      <div className="stat-grid">
        {snap.state.order.map((id) => {
          const s = stats[id]!;
          const share = totalDone ? Math.round((s.done / totalDone) * 100) : 0;
          return (
            <div key={id} className="stat-card" style={cssVar(people[id]?.color ?? '#999')}>
              <div className="row"><Avatar person={people[id]} /><strong className="grow" style={{ fontSize: '1.05rem' }}>{people[id]?.name}</strong><span className="muted small">{share}% del total</span></div>
              <div className="dual" role="img" aria-label={`${people[id]?.name}: ${s.assigned} asignadas, ${s.done} realizadas`}>
                <div className="bar-track"><div className="bar-fill ghost" style={{ width: `${(s.assigned / max) * 100}%` }} /><div className="bar-fill solid" style={{ width: `${(s.done / max) * 100}%` }} /></div>
              </div>
              <div className="row between"><div><div className="big-num">{s.done}</div><div className="muted small">realizadas</div></div><div style={{ textAlign: 'right' }}><div className="big-num" style={{ color: 'var(--muted)' }}>{s.assigned}</div><div className="muted small">asignadas</div></div></div>
              <div className="stack-sm small">
                <div className="kv"><span className="muted">Cubrió a otros</span><strong>{s.coveredForOthers}</strong></div>
                <div className="kv"><span className="muted">Asignadas que no hizo</span><strong>{s.notDoneByMe}</strong></div>
                <div className="kv"><span className="muted">Próximos 30 días</span><strong>{s.upcoming30}</strong></div>
                <div className="kv"><span className="muted">Debe compensar</span><strong>{s.owes}</strong></div>
                <div className="kv"><span className="muted">Le deben</span><strong>{s.isOwed}</strong></div>
              </div>
            </div>
          );
        })}
      </div>
      {stats['mom'] && stats['mom'].done > 0 && <p className="muted small">Mamá ha hecho la cocina {stats['mom'].done} vez/veces como excepción (no cuenta en la rotación).</p>}
    </section>
  );
}
