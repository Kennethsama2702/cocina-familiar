import { useMemo, useState } from 'react';
import {
  MOM, Ctx, OpResult, Plan, State, addMomException, cancelMomException, changeAssignee, compViews, formatLong, getShift, isAbsent, markShift, momCoversAbsentTurn, skipDay, undoSkipDay,
} from '../domain';
import { Snapshot } from '../data/repository';
import { Avatar, Confirm, Dialog, Icon, People } from './common';

export type Run = (op: (s: State, c: Ctx) => OpResult, ok: string, settings?: Plan['settings']) => Promise<boolean>;

interface Props {
  date: string;
  snap: Snapshot;
  people: People;
  busy: boolean;
  run: Run;
  onClose: () => void;
  onAbsence: (date: string) => void;
  onSchedule: (compId: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  rotation: 'Rotación habitual', mom: 'Excepción de mamá', cover: 'Adelantado por un viaje', manual: 'Cambio manual', compensation: 'Recupera su turno / compensación',
};

export function DayPanel({ date, snap, people, busy, run, onClose, onAbsence, onSchedule }: Props) {
  const { state, today } = snap;
  const shift = getShift(state, date);
  const admin = snap.role === 'admin';
  const past = date < today;
  const isToday = date === today;
  const editable = admin && !past && !!shift;
  const [mode, setMode] = useState<null | 'change' | 'done' | 'mom' | 'cancelMom' | 'skip'>(null);
  const ownerAway = !!shift && isAbsent(state, shift.original, date);
  const n = (id: string | null) => (id ? people[id]?.name ?? id : '—');
  const comps = useMemo(() => compViews(state), [state]);

  if (!shift) return null;
  const gen = shift.generatesComp ? comps.find((c) => c.id === shift.generatesComp) : null;
  const settle = shift.settlesComp ? comps.find((c) => c.id === shift.settlesComp) : null;

  return (
    <Dialog side title={formatLong(date)} onClose={onClose}>
      <div className="row">
        <Avatar person={people[shift.assignee]} />
        <div className="grow">
          <div style={{ fontWeight: 650, fontSize: '1.15rem' }}>{n(shift.assignee)}</div>
          <div className="muted small">{KIND_LABEL[shift.kind]}{isToday ? ' · Hoy' : ''}{past ? ' · Día pasado (solo lectura)' : ''}</div>
        </div>
      </div>

      <div className="stack-sm">
        <div className="kv"><span className="muted">Responsable original</span><strong>{n(shift.original)}</strong></div>
        {shift.status === 'done' && <div className="kv"><span className="muted">La realizó</span><strong>{n(shift.performedBy)}</strong></div>}
        {shift.status === 'skipped' && <div className="note">Ese día nadie cocinó. El turno de {n(shift.assignee)} pasó al día siguiente y la rotación se corrió un día.</div>}
        {past && shift.status === 'scheduled' && <div className="kv"><span className="muted">Estado</span><span>Sin registro (se cuenta como hecha por {n(shift.assignee)})</span></div>}
        {shift.reason && <div className="kv"><span className="muted">Motivo</span><span style={{ textAlign: 'right' }}>{shift.reason}</span></div>}
        {gen && <div className="note ok">{n(gen.debtor)} debe compensar a {n(gen.creditor)} · {gen.status === 'pending' ? 'pendiente' : gen.status === 'scheduled' ? `programada el ${gen.settleDate}` : gen.status === 'done' ? 'ya compensada' : 'cancelada'}</div>}
        {settle && <div className="note ok">Este turno salda lo que {n(settle.debtor)} debía a {n(settle.creditor)}.</div>}
      </div>

      {editable && mode === null && (
        <div className="section">
          <h3>Acciones</h3>
          <div className="stack-sm">
            {isToday && shift.status === 'scheduled' && <button className="btn primary" onClick={() => setMode('done')}><Icon name="check" /> Registrar quién la hizo hoy</button>}
            {shift.status === 'skipped' && (
              <button className="btn" disabled={busy} onClick={() => void run((s, c) => undoSkipDay(s, date, c), 'Listo: ese día sí se cocina.').then((ok) => ok && onClose())}><Icon name="undo" /> Deshacer: ese día sí se cocina</button>
            )}
            {isToday && shift.status === 'done' && (
              <button className="btn" disabled={busy} onClick={() => void run((s, c) => markShift(s, { date, status: 'scheduled' }, c), 'Registro deshecho.')}><Icon name="undo" /> Deshacer el registro</button>
            )}
            {shift.kind !== 'mom' && shift.status === 'scheduled' && <button className="btn" onClick={() => setMode('change')}><Icon name="swap" /> Cambiar responsable</button>}
            {shift.kind !== 'mom' && shift.kind !== 'manual' && shift.status === 'scheduled' && ownerAway && (
              <button className="btn" disabled={busy} onClick={() => void run((s, c) => momCoversAbsentTurn(s, date, c), 'Mamá cubre el turno; el patrón no se mueve.').then((ok) => ok && onClose())}>
                <Icon name="heart" /> Mamá cubre el turno de {people[shift.original]?.name} (reemplazo, no mueve nada)
              </button>
            )}
            {shift.kind !== 'mom' && shift.status === 'scheduled' && <button className="btn" onClick={() => setMode('mom')}><Icon name="heart" /> Mamá hace la cocina este día{ownerAway ? ' (desplaza lo posterior)' : ''}</button>}
            {shift.kind === 'mom' && shift.status === 'scheduled' && <button className="btn danger" onClick={() => setMode('cancelMom')}>Cancelar excepción de mamá</button>}
            {shift.kind !== 'mom' && shift.status === 'scheduled' && <button className="btn" onClick={() => setMode('skip')}><Icon name="x" /> Ese día nadie cocina (se corre todo un día)</button>}
            <button className="btn" onClick={() => onAbsence(date)}><Icon name="plane" /> Registrar viaje o ausencia</button>
            {gen && gen.status === 'pending' && <button className="btn" onClick={() => onSchedule(gen.id)}>Programar compensación</button>}
          </div>
        </div>
      )}

      {editable && mode === 'change' && <ChangeForm date={date} snap={snap} people={people} busy={busy} run={run} onBack={() => setMode(null)} onDone={onClose} />}
      {editable && mode === 'done' && <DoneForm date={date} snap={snap} people={people} busy={busy} run={run} onBack={() => setMode(null)} onDone={onClose} />}
      {editable && mode === 'mom' && (
        <MomForm date={date} snap={snap} people={people} busy={busy} run={run} onBack={() => setMode(null)} onDone={onClose} />
      )}
      {editable && mode === 'skip' && <SkipForm date={date} snap={snap} people={people} busy={busy} run={run} onBack={() => setMode(null)} onDone={onClose} />}
      {editable && mode === 'cancelMom' && (
        <Confirm
          title="¿Cancelar la excepción de mamá?"
          body={<>Se quitará el turno de mamá del {formatLong(date)} y <strong>toda la rotación posterior se adelantará un día</strong>. Quedará registrado en el historial.</>}
          confirmLabel="Sí, cancelar excepción" danger busy={busy}
          onCancel={() => setMode(null)}
          onConfirm={() => void run((s, c) => cancelMomException(s, date, null, c), 'Excepción cancelada.').then((ok) => ok && onClose())}
        />
      )}
      {past && admin && <div className="note"><Icon name="lock" size={13} /> Los días pasados están bloqueados: ni la interfaz ni la base de datos permiten modificarlos.</div>}
    </Dialog>
  );
}

function ChangeForm({ date, snap, people, busy, run, onBack, onDone }: Omit<Props, 'onClose' | 'onAbsence' | 'onSchedule'> & { onBack: () => void; onDone: () => void }) {
  const shift = getShift(snap.state, date)!;
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [comp, setComp] = useState(false);
  const [err, setErr] = useState('');
  const options = snap.state.order.filter((id) => id !== shift.assignee);
  const canComp = !!to && to !== shift.original && shift.assignee !== MOM && !shift.generatesComp;
  const submit = async () => {
    if (!to) return setErr('Elige a la nueva persona responsable.');
    if (!reason.trim()) return setErr('El motivo es obligatorio.');
    setErr('');
    const ok = await run((s, c) => changeAssignee(s, { date, newAssignee: to, reason, createCompensation: comp && canComp }, c), 'Responsable actualizado.');
    if (ok) onDone();
  };
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>Cambiar responsable</h3>
      <label className="field">Nuevo responsable
        <select value={to} onChange={(e) => setTo(e.target.value)} data-autofocus>
          <option value="">Elegir…</option>
          {options.map((id) => {
            const away = isAbsent(snap.state, id, date);
            return <option key={id} value={id} disabled={away}>{people[id]?.name}{away ? ' (ausente)' : ''}</option>;
          })}
        </select>
      </label>
      <label className="field">Motivo <span className="hint">Obligatorio; queda en el historial.</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </label>
      {canComp && (
        <label className="opt"><input type="checkbox" checked={comp} onChange={(e) => setComp(e.target.checked)} />
          <span>Generar compensación: {people[shift.assignee]?.name} le deberá un turno a {people[to]?.name}</span></label>
      )}
      <p className="muted small">El responsable original ({people[shift.original]?.name}) se conserva en el registro.</p>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row between"><button type="button" className="btn" onClick={onBack} disabled={busy}>Atrás</button><button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar cambio'}</button></div>
    </form>
  );
}

function DoneForm({ date, snap, people, busy, run, onBack, onDone }: Omit<Props, 'onClose' | 'onAbsence' | 'onSchedule'> & { onBack: () => void; onDone: () => void }) {
  const shift = getShift(snap.state, date)!;
  const [kind, setKind] = useState<'same' | 'other' | 'none'>('same');
  const [other, setOther] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    if (kind === 'other' && (!other || !reason.trim())) return setErr('Elige quién la hizo e indica el motivo.');
    setErr('');
    const ok = await run(
      (s, c) => kind === 'none'
        ? skipDay(s, date, reason || null, c)
        : markShift(s, { date, status: 'done', performedBy: kind === 'same' ? shift.assignee : other, reason: reason || null }, c),
      'Registro guardado.',
    );
    if (ok) onDone();
  };
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <h3>¿Quién limpió la cocina hoy?</h3>
      <div className="stack-sm" role="radiogroup">
        <label className="opt"><input type="radio" name="k" checked={kind === 'same'} onChange={() => setKind('same')} data-autofocus /><span>{people[shift.assignee]?.name} (responsable)</span></label>
        <label className="opt"><input type="radio" name="k" checked={kind === 'other'} onChange={() => setKind('other')} /><span>Otra persona</span></label>
        <label className="opt"><input type="radio" name="k" checked={kind === 'none'} onChange={() => setKind('none')} /><span>Nadie cocinó hoy <span className="muted small">(el turno pasa a mañana)</span></span></label>
      </div>
      {kind === 'other' && (
        <label className="field">Quién la hizo
          <select value={other} onChange={(e) => setOther(e.target.value)}>
            <option value="">Elegir…</option>
            {snap.state.order.filter((id) => id !== shift.assignee).map((id) => <option key={id} value={id}>{people[id]?.name}</option>)}
          </select>
        </label>
      )}
      {kind !== 'same' && (
        <label className="field">Motivo{kind === 'other' ? '' : ' (opcional)'}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
      )}
      {kind === 'none' && <div className="note">El turno de {people[shift.assignee]?.name} pasará a mañana y <strong>toda la rotación posterior se correrá un día</strong>, igual que con una excepción de mamá.</div>}
      <p className="muted small">Si mamá la hizo, usa “Mamá hace la cocina este día” para que se desplace la rotación.</p>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row between"><button type="button" className="btn" onClick={onBack} disabled={busy}>Atrás</button><button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
    </form>
  );
}

function MomForm({ date, snap, people, busy, run, onBack, onDone }: Omit<Props, 'onClose' | 'onAbsence' | 'onSchedule'> & { onBack: () => void; onDone: () => void }) {
  const shift = getShift(snap.state, date)!;
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <Confirm
        title="¿Confirmar excepción de mamá?" confirmLabel="Confirmar" busy={busy} onCancel={() => setConfirm(false)}
        body={<>Mamá limpiará el {formatLong(date)}. <strong>{people[shift.assignee]?.name}</strong> y toda la rotación posterior se desplazan <strong>un día</strong> (cambia también en otros meses). Se guardará en el historial.</>}
        onConfirm={() => void run((s, c) => addMomException(s, date, reason || null, c), 'Excepción de mamá registrada.').then((ok) => ok && onDone())}
      />
    );
  }
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
      <h3>Mamá hace la cocina</h3>
      <p className="muted small">
        {people[shift.assignee]?.name} pasa al día siguiente y todo lo posterior se corre un día. Cada excepción desplaza una sola vez.
      </p>
      <label className="field">Motivo <span className="hint">Opcional</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-autofocus />
      </label>
      <div className="row between"><button type="button" className="btn" onClick={onBack} disabled={busy}>Atrás</button><button className="btn primary">Continuar</button></div>
    </form>
  );
}

function SkipForm({ date, snap, people, busy, run, onBack, onDone }: Omit<Props, 'onClose' | 'onAbsence' | 'onSchedule'> & { onBack: () => void; onDone: () => void }) {
  const shift = getShift(snap.state, date)!;
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  if (confirm) {
    return (
      <Confirm
        title="¿Ese día nadie cocina?" confirmLabel="Confirmar" busy={busy} onCancel={() => setConfirm(false)}
        body={<>El {formatLong(date)} nadie cocinará. <strong>{people[shift.assignee]?.name}</strong> lo hará al día siguiente y <strong>toda la rotación posterior se corre un día</strong>. Queda en el historial y se puede deshacer.</>}
        onConfirm={() => void run((s, c) => skipDay(s, date, reason || null, c), 'Listo: el turno pasó al día siguiente.').then((ok) => ok && onDone())}
      />
    );
  }
  return (
    <form className="section" onSubmit={(e) => { e.preventDefault(); setConfirm(true); }}>
      <h3>Ese día nadie cocina</h3>
      <p className="muted small">Por ejemplo, si se cenó tarde. El turno de {people[shift.assignee]?.name} pasa al día siguiente y todo lo posterior se corre un día.</p>
      <label className="field">Motivo <span className="hint">Opcional</span>
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-autofocus />
      </label>
      <div className="row between"><button type="button" className="btn" onClick={onBack} disabled={busy}>Atrás</button><button className="btn primary">Continuar</button></div>
    </form>
  );
}
