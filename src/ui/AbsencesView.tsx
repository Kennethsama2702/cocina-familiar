import { compStatusLabel, compViews, formatShort, upcomingAbsences } from '../domain';
import { Snapshot } from '../data/repository';
import { People } from './common';

export function AbsencesView({ snap, people, admin, onNew, onCancelAbsence, onSchedule, onCancelComp }: {
  snap: Snapshot; people: People; admin: boolean; onNew: () => void;
  onCancelAbsence: (id: string) => void; onSchedule: (id: string) => void; onCancelComp: (id: string) => void;
}) {
  const n = (id: string) => people[id]?.name ?? id;
  const abs = upcomingAbsences(snap.state, { today: snap.today });
  const comps = compViews(snap.state);
  const open = comps.filter((c) => c.status === 'pending' || c.status === 'scheduled');
  const closed = comps.filter((c) => c.status === 'done' || c.status === 'cancelled').slice(-12).reverse();
  return (
    <div className="stack">
      <section className="card stack">
        <div className="row between wrap">
          <h2>Viajes y ausencias</h2>
          {admin && <button className="btn primary" onClick={onNew}>Registrar ausencia</button>}
        </div>
        {abs.length === 0 ? <p className="muted">No hay ausencias vigentes ni programadas.</p> : (
          <div className="list">
            {abs.map((a) => (
              <div key={a.id} className="list-item">
                <div className="grow">
                  <strong>{n(a.person)}</strong> <span className="muted">· {formatShort(a.start)}{a.end !== a.start ? ` → ${formatShort(a.end)}` : ''}</span>
                  {a.reason && snap.settings.showReasons || (admin && a.reason) ? <div className="muted small">{a.reason}</div> : null}
                </div>
                {admin && <button className="btn sm danger" onClick={() => onCancelAbsence(a.id)}>Cancelar</button>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card stack">
        <h2>Compensaciones</h2>
        {open.length === 0 ? <p className="muted">No hay compensaciones abiertas. Todos están al día.</p> : (
          <div className="list">
            {open.map((c) => (
              <div key={c.id} className="list-item">
                <div className="grow">
                  <strong>{n(c.debtor)}</strong> debe un turno a <strong>{n(c.creditor)}</strong>
                  <div className="muted small">
                    {c.originDate ? `Cubrió el ${formatShort(c.originDate)} · ` : ''}{compStatusLabel(c.status)}{c.settleDate ? ` el ${formatShort(c.settleDate)}` : ''}
                  </div>
                </div>
                {admin && (
                  <div className="row wrap">
                    {c.status === 'pending' && <button className="btn sm primary" onClick={() => onSchedule(c.id)}>Programar</button>}
                    <button className="btn sm" onClick={() => onCancelComp(c.id)}>Cancelar</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {closed.length > 0 && (
          <details>
            <summary className="muted small" style={{ cursor: 'pointer' }}>Cerradas recientemente ({closed.length})</summary>
            <div className="list">
              {closed.map((c) => (
                <div key={c.id} className="list-item small">
                  <span className="grow">{n(c.debtor)} → {n(c.creditor)}</span><span className="muted">{compStatusLabel(c.status)}{c.settleDate ? ` · ${formatShort(c.settleDate)}` : ''}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>
    </div>
  );
}
