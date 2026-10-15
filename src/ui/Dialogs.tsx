import { useMemo, useState } from 'react';
import {
  MOM, addDays, cancelAbsence, cancelCompensation, createAbsence, formatShort, isIsoDate, previewAbsence, proposeCompensation, scheduleCompensation, compViews, DomainError,
} from '../domain';
import { Snapshot } from '../data/repository';
import { Confirm, Dialog, People } from './common';
import { Run } from './DayPanel';

export function AbsenceDialog({ snap, people, busy, run, initialDate, onClose }: {
  snap: Snapshot; people: People; busy: boolean; run: Run; initialDate: string; onClose: () => void;
}) {
  const [person, setPerson] = useState('');
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [reason, setReason] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [momDays, setMomDays] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const input = { person, start, end, reason: reason.trim() || null };
  const ctx = { today: snap.today, names: Object.fromEntries(Object.values(people).map((x) => [x.id, x.name])) };
  const n = (id: string | null) => (id ? people[id]?.name ?? id : '—');

  const preview = useMemo(() => {
    if (!reviewed) return null;
    try { return { p: previewAbsence(snap.state, input, momDays, ctx), error: '' }; }
    catch (e) { return { p: null, error: e instanceof DomainError ? e.message : 'No se pudo calcular el resultado.' }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewed, person, start, end, reason, momDays, snap]);

  const review = () => {
    setErr('');
    if (!person) return setErr('Elige quién viaja.');
    if (!isIsoDate(start) || !isIsoDate(end)) return setErr('Indica las fechas de salida y regreso.');
    try { previewAbsence(snap.state, input, [], ctx); setMomDays([]); setReviewed(true); }
    catch (e) { setErr(e instanceof DomainError ? e.message : 'No se pudo calcular el resultado.'); }
  };
  const save = async () => {
    const ok = await run((s, c) => createAbsence(s, input, momDays, c), 'Ausencia registrada.');
    if (ok) onClose();
  };
  const dirty = () => { if (reviewed) { setReviewed(false); setMomDays([]); } };
  const p = preview?.p ?? null;
  const returnDay = end ? addDays(end, 1) : '';

  return (
    <Dialog title="Registrar viaje o ausencia" onClose={onClose} wide>
      <div className="stack">
        <div className="row wrap">
          <label className="field grow" style={{ minWidth: 160 }}>Persona
            <select value={person} onChange={(e) => { setPerson(e.target.value); dirty(); }} data-autofocus>
              <option value="">Elegir…</option>
              {snap.state.order.map((id) => <option key={id} value={id}>{people[id]?.name}</option>)}
            </select>
          </label>
          <label className="field grow" style={{ minWidth: 140 }}>Salida (primer día fuera)
            <input type="date" value={start} onChange={(e) => { setStart(e.target.value); if (e.target.value > end) setEnd(e.target.value); dirty(); }} />
          </label>
          <label className="field grow" style={{ minWidth: 140 }}>Último día fuera
            <input type="date" value={end} min={start} onChange={(e) => { setEnd(e.target.value); dirty(); }} />
          </label>
        </div>
        <p className="muted small">{person ? `${n(person)} puede volver a cocinar desde el ${returnDay ? formatShort(returnDay) : '…'}.` : 'Indica el último día en que la persona estará fuera; al día siguiente ya puede cocinar.'}</p>
        <label className="field">Motivo <span className="hint">Opcional</span>
          <input type="text" value={reason} maxLength={200} onChange={(e) => { setReason(e.target.value); dirty(); }} />
        </label>
        {err && <p className="error-text" role="alert">{err}</p>}

        {!reviewed && <div className="row between"><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={review}>Ver cómo queda el calendario</button></div>}

        {reviewed && preview?.error && <p className="error-text" role="alert">{preview.error}</p>}
        {reviewed && p && (
          <div className="stack">
            {p.lost.length === 0 ? (
              <div className="note ok">Esta ausencia no coincide con ningún turno de {n(person)}. Se registra igualmente para que no se le asignen turnos mientras esté fuera.</div>
            ) : (
              <>
                <div className="note">
                  Los turnos de {n(person)} dentro del viaje no se cocinan: <strong>los siguientes se adelantan un día</strong> y {n(person)} <strong>recupera su turno al volver</strong>. Desde ahí el patrón sigue como antes.
                </div>
                <fieldset style={{ border: 0, padding: 0, margin: 0 }} className="stack-sm">
                  <legend className="small muted" style={{ marginBottom: 6 }}>¿Mamá cubre alguno de esos turnos? (reemplazo: no se mueve a nadie)</legend>
                  {p.lost.map((d) => (
                    <label key={d} className="opt">
                      <input type="checkbox" checked={momDays.includes(d)} onChange={(e) => setMomDays(e.target.checked ? [...momDays, d] : momDays.filter((x) => x !== d))} />
                      <span>{formatShort(d)}: que cubra {n(MOM)}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {p.changes.length > 0 && (
              <div>
                <h3 style={{ marginBottom: 6 }}>Cambios en el calendario</h3>
                <div className="table-wrap"><table>
                  <thead><tr><th>Día</th><th>Antes</th><th>Después</th></tr></thead>
                  <tbody>
                    {p.changes.slice(0, 14).map((c) => (
                      <tr key={c.date}><td style={{ whiteSpace: 'nowrap' }}>{formatShort(c.date)}</td><td className="muted">{n(c.from)}</td><td><strong>{n(c.to)}</strong></td></tr>
                    ))}
                  </tbody>
                </table></div>
                {p.changes.length > 14 && <p className="muted small">… y {p.changes.length - 14} día(s) más.</p>}
              </div>
            )}
            {p.warnings.map((w) => <div key={w} className="note warn">{w}</div>)}
            <div className="row between wrap">
              <button className="btn" onClick={() => { setReviewed(false); setMomDays([]); }} disabled={busy}>Editar datos</button>
              <button className="btn primary" onClick={() => void save()} disabled={busy}>{busy ? 'Guardando…' : 'Guardar ausencia'}</button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function CompDialog({ snap, people, busy, run, compId, onClose }: {
  snap: Snapshot; people: People; busy: boolean; run: Run; compId: string; onClose: () => void;
}) {
  const view = compViews(snap.state).find((c) => c.id === compId);
  const proposal = useMemo(() => {
    try { return proposeCompensation(snap.state, compId, { today: snap.today }); } catch { return null; }
  }, [snap, compId]);
  const [date, setDate] = useState<string>(proposal?.options[0]?.date ?? '');
  if (!view) return null;
  const n = (id: string) => people[id]?.name ?? id;
  return (
    <Dialog title="Programar compensación" onClose={onClose}>
      <p>{n(view.debtor)} le debe un turno a {n(view.creditor)}{view.originDate ? ` (cubrió el ${formatShort(view.originDate)})` : ''}. {n(view.debtor)} tomará uno de los turnos de {n(view.creditor)}; el resto del patrón no cambia.</p>
      {!proposal || proposal.options.length === 0 ? (
        <div className="note warn">No hay turnos de {n(view.creditor)} disponibles en los próximos meses. Puedes dejarla pendiente o cancelarla.</div>
      ) : (
        <>
          {!proposal.clear && <div className="note warn">No hay una opción claramente equitativa (todas dejan turnos pegados). Elige la que prefieras.</div>}
          <div className="stack-sm" role="radiogroup" aria-label="Fechas propuestas">
            {proposal.options.map((o) => (
              <label key={o.date} className="opt">
                <input type="radio" name="comp" checked={date === o.date} onChange={() => setDate(o.date)} />
                <span className="grow"><strong>{formatShort(o.date)}</strong><br /><span className="muted small">{o.note}</span></span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="row between wrap">
        <button className="btn" onClick={onClose}>Cerrar</button>
        <button className="btn primary" disabled={busy || !date} onClick={() => void run((s, c) => scheduleCompensation(s, compId, date, c), 'Compensación programada.').then((ok) => ok && onClose())}>{busy ? 'Guardando…' : 'Programar'}</button>
      </div>
    </Dialog>
  );
}

export function CancelCompDialog({ compId, busy, run, onClose }: { compId: string; busy: boolean; run: Run; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  return (
    <Dialog title="Cancelar compensación" onClose={onClose}>
      <label className="field">Motivo <span className="hint">Obligatorio</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-autofocus />
      </label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row between">
        <button className="btn" onClick={onClose} disabled={busy}>Volver</button>
        <button className="btn danger" disabled={busy} onClick={() => {
          if (!reason.trim()) return setErr('Indica el motivo.');
          void run((s, c) => cancelCompensation(s, compId, reason, c), 'Compensación cancelada.').then((ok) => ok && onClose());
        }}>Cancelar compensación</button>
      </div>
    </Dialog>
  );
}

export function CancelAbsenceDialog({ absenceId, people, snap, busy, run, onClose }: { absenceId: string; people: People; snap: Snapshot; busy: boolean; run: Run; onClose: () => void }) {
  const a = snap.state.absences.find((x) => x.id === absenceId);
  if (!a) return null;
  return (
    <Confirm
      title="¿Cancelar la ausencia?" confirmLabel="Cancelar ausencia" danger busy={busy} onCancel={onClose}
      body={<>La ausencia de {people[a.person]?.name} ({formatShort(a.start)} – {formatShort(a.end)}) se cancelará. Los turnos futuros que otros cubrieron vuelven a {people[a.person]?.name} y sus compensaciones pendientes se cancelan. Los días pasados no cambian.</>}
      onConfirm={() => void run((s, c) => cancelAbsence(s, absenceId, c), 'Ausencia cancelada.').then((ok) => ok && onClose())}
    />
  );
}
