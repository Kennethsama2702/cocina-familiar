import { useState } from 'react';
import { MOM, Participant, addDays, addRotationMember, orderWith, rebuildFuture, setupRotation, formatLong } from '../domain';
import { Snapshot, rotateShareToken } from '../data/repository';
import { Confirm, Dialog, Icon, People, Avatar } from './common';
import { Run } from './DayPanel';

export function shareUrl(token: string) {
  return `${window.location.origin}${window.location.pathname}#/ver/${token}`;
}

export function SettingsView({ snap, people, busy, run, saveSettings, reload, notify, onLogout }: {
  snap: Snapshot; people: People; busy: boolean; run: Run;
  saveSettings: (s: { show_history?: boolean; show_reasons?: boolean }, summary: string) => Promise<boolean>;
  reload: () => Promise<unknown>; notify: (k: 'ok' | 'err', t: string) => void; onLogout: () => void;
}) {
  const url = snap.shareToken ? shareUrl(snap.shareToken) : '';
  const [confirmToken, setConfirmToken] = useState(false);
  const [working, setWorking] = useState(false);
  const todayRow = snap.state.shifts.find((x) => x.date === snap.today);
  const [from, setFrom] = useState(todayRow && todayRow.status !== 'scheduled' ? addDays(snap.today, 1) : snap.today);
  const [start, setStart] = useState(snap.state.order[0] ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [adding, setAdding] = useState(false);

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); notify('ok', 'Enlace copiado.'); } catch { notify('err', 'No se pudo copiar; selecciónalo manualmente.'); }
  };
  const regenerate = async () => {
    setWorking(true);
    try { await rotateShareToken(); await reload(); notify('ok', 'Enlace nuevo generado. El anterior ya no funciona.'); setConfirmToken(false); }
    catch (e) { notify('err', (e as Error).message); } finally { setWorking(false); }
  };
  const doRebuild = async () => {
    const ok = await run((s, c) => rebuildFuture(s, from, start, reason.trim() || 'Rotación nueva', c), 'Rotación nueva generada desde esa fecha.');
    if (ok) { setConfirmRebuild(false); setReason(''); }
  };

  return (
    <div className="stack">
      <section className="card stack">
        <h2>Enlace para la familia</h2>
        <p className="muted">Quien tenga este enlace puede <strong>ver</strong> el calendario sin crear cuenta. Nadie puede modificar nada con él: la base de datos solo le permite leer.</p>
        <div className="linkbox mono" data-testid="share-url">{url}</div>
        <div className="row wrap">
          <button className="btn primary" onClick={() => void copy()}><Icon name="copy" /> Copiar enlace</button>
          <button className="btn danger" onClick={() => setConfirmToken(true)}>Generar enlace nuevo</button>
        </div>
        <div className="note">
          <strong>Qué ve quien tiene el enlace:</strong> turnos (pasados y futuros según tu elección), nombres de los cuatro participantes y de mamá, excepciones, ausencias y compensaciones.<br />
          <strong>Qué no ve:</strong> tu correo o contraseña, cuentas, el enlace en sí, ni los motivos escritos (salvo que los actives abajo). El enlace va en la parte “#” de la dirección, que los navegadores no envían a ningún servidor.<br />
          Si el enlace se filtra, genera uno nuevo: el anterior deja de funcionar al instante.
        </div>
      </section>

      <section className="card stack">
        <h2>Qué pueden consultar los visitantes</h2>
        <label className="opt"><input type="checkbox" checked={snap.settings.showHistory} disabled={busy}
          onChange={(e) => void saveSettings({ show_history: e.target.checked }, e.target.checked ? 'Historial visible para visitantes' : 'Historial oculto para visitantes')} />
          <span className="grow"><strong>Historial</strong><br /><span className="muted small">Días pasados, registro de cambios y estadísticas. Si lo desactivas, solo ven de hoy en adelante.</span></span></label>
        <label className="opt"><input type="checkbox" checked={snap.settings.showReasons} disabled={busy}
          onChange={(e) => void saveSettings({ show_reasons: e.target.checked }, e.target.checked ? 'Motivos visibles para visitantes' : 'Motivos ocultos para visitantes')} />
          <span className="grow"><strong>Motivos de los cambios</strong><br /><span className="muted small">Textos libres de cambios, viajes y excepciones. Desactivado por defecto por privacidad.</span></span></label>
      </section>

      <section className="card stack">
        <h2>Integrantes de la rotación</h2>
        <div className="stack-sm">
          {snap.state.order.map((id) => (
            <div key={id} className="row"><Avatar person={people[id]} small /><span className="grow">{people[id]?.name}</span></div>
          ))}
        </div>
        <p className="muted small">Al añadir a alguien, la rotación se vuelve a generar desde la fecha que elijas con el nuevo orden. Los días pasados no cambian.</p>
        <button className="btn" onClick={() => setAdding(true)} disabled={busy}><Icon name="plus" /> Añadir integrante</button>
      </section>

      <section className="card stack">
        <h2>Reglas de la rotación</h2>
        <p className="muted small">Orden: {snap.state.order.map((id) => people[id]?.name).join(' → ')} → … y se repite. Zona horaria: America/Guayaquil (la decide el servidor). Mamá no forma parte del orden: sus excepciones desplazan un día toda la rotación posterior.</p>
        <p className="muted small">Viajes: quien está de viaje sale de la fila; los siguientes se adelantan y quien viajó recupera su turno al volver (seguidos si perdió más de uno). Si mamá cubre el turno de quien viaja, es un reemplazo y nada se mueve. No hay azar.</p>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Empezar de cero (borrar la rotación)</summary>
          <div className="note warn" style={{ marginTop: 12 }}>
            Borrar <strong>toda</strong> la rotación, incluidos los días pasados, no se puede hacer desde la app: los días pasados están bloqueados a propósito.
            Si de verdad quieres empezar de cero, ejecuta el archivo <span className="mono">supabase/reset_calendar.sql</span> en el SQL Editor de Supabase (paso a paso en el README).
            Si solo quieres borrar desde hoy en adelante y conservar lo anterior, usa “Borrar la rotación desde hoy y empezar una nueva”.
          </div>
        </details>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Borrar la rotación desde hoy y empezar una nueva</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="note warn">Borra todo lo programado desde esa fecha en adelante (excepciones de mamá, coberturas, cambios) y genera una rotación nueva con el orden actual. Lo anterior a esa fecha no se toca. Si hoy ya tiene un registro, empieza mañana.</div>
            <div className="row wrap">
              <label className="field grow">Desde<input type="date" value={from} min={snap.today} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field grow">Empieza<select value={start} onChange={(e) => setStart(e.target.value)}>{snap.state.order.map((id) => <option key={id} value={id}>{people[id]?.name}</option>)}</select></label>
            </div>
            <label className="field">Motivo <span className="hint">Opcional</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
            {err && <p className="error-text" role="alert">{err}</p>}
            <button className="btn danger" onClick={() => { setErr(''); setConfirmRebuild(true); }}>Borrar y generar rotación nueva</button>
          </div>
        </details>
      </section>

      <section className="card row between wrap">
        <div><strong>Sesión de administrador</strong><div className="muted small">Hoy es {formatLong(snap.today)} (hora de Ecuador, según el servidor).</div></div>
        <button className="btn" onClick={onLogout}><Icon name="logout" /> Cerrar sesión</button>
      </section>

      {adding && <AddMemberDialog snap={snap} people={people} busy={busy} run={run} onClose={() => setAdding(false)} />}
      {confirmToken && <Confirm title="¿Generar un enlace nuevo?" danger confirmLabel="Generar enlace nuevo" busy={working} onCancel={() => setConfirmToken(false)} onConfirm={() => void regenerate()}
        body="El enlace actual dejará de funcionar y tendrás que compartir el nuevo con la familia." />}
      {confirmRebuild && <Confirm title="¿Reconstruir la rotación?" danger confirmLabel="Reconstruir" busy={busy} onCancel={() => setConfirmRebuild(false)} onConfirm={() => void doRebuild()}
        body={<>Desde el {formatLong(from)} empezará {people[start]?.name}. Se perderán las excepciones y coberturas posteriores; queda constancia en el historial.</>} />}
    </div>
  );
}

export function SetupView({ snap, people, busy, run }: { snap: Snapshot; people: People; busy: boolean; run: Run }) {
  const order = Object.values(people).filter((p) => p.inRotation).sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id);
  const [first, setFirst] = useState(order[0] ?? '');
  const go = () => run((_s, c) => setupRotation(order, first, c), 'Calendario creado.', { rotation_start: snap.today });
  return (
    <div className="center-screen"><div className="card auth-card">
      <h1 style={{ fontSize: '1.4rem' }}>Configura la rotación</h1>
      <p className="muted">La rotación empieza hoy, {formatLong(snap.today)}, y sigue el orden {order.map((id) => people[id]?.name).join(' → ')}. ¿Quién limpia hoy?</p>
      <div className="seg" role="radiogroup" aria-label="Quién inicia">
        {order.map((id) => (
          <label key={id}><input type="radio" name="first" checked={first === id} onChange={() => setFirst(id)} /><span>{people[id]?.name}</span></label>
        ))}
      </div>
      <p className="muted small">Se generan los próximos dos años y se amplían solos. Mamá ({people[MOM]?.name}) se registra como excepción cuando limpia.</p>
      <button className="btn primary" disabled={busy || !first} onClick={() => void go()}>{busy ? 'Creando…' : 'Crear calendario'}</button>
      <p className="muted small">Mañana ({formatLong(addDays(snap.today, 1))}) seguirá {people[order[(order.indexOf(first) + 1) % order.length]!]?.name}.</p>
    </div></div>
  );
}

const COLORS = ['#7C5CBF', '#2E9CCA', '#C2557A', '#5B8C3A', '#D2691E', '#3F7F8C'];

function slug(name: string, taken: Set<string>): string {
  const base = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'persona';
  let id = base.length < 2 ? `${base}_` : base;
  for (let i = 2; taken.has(id) || id === MOM; i++) id = `${base}_${i}`.slice(0, 24);
  return id;
}

function AddMemberDialog({ snap, people, busy, run, onClose }: { snap: Snapshot; people: People; busy: boolean; run: Run; onClose: () => void }) {
  const order = snap.state.order;
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[order.length % COLORS.length]!);
  const [after, setAfter] = useState<string>(order[order.length - 1] ?? '');
  const [from, setFrom] = useState(addDays(snap.today, 1));
  const [startAuto, setStartAuto] = useState(true);
  const [startPerson, setStartPerson] = useState('');
  const [err, setErr] = useState('');
  const id = slug(name.trim(), new Set(Object.keys(people)));
  const trimmed = name.trim();
  const newOrder = orderWith(order, id, after || null);
  // Por defecto, quien ya cocinaba ese día sigue cocinando (el nuevo integrante entra después en la fila).
  const current = snap.state.shifts.find((x) => x.date === from);
  const defaultStart = current && current.slot && order.includes(current.slot) ? current.slot : order[0]!;
  const start = startAuto ? defaultStart : startPerson || defaultStart;
  const nameMap = { ...Object.fromEntries(Object.values(people).map((p) => [p.id, p.name])), [id]: trimmed || 'Nuevo' };
  const preview = (() => {
    if (!trimmed) return null;
    try {
      const r = addRotationMember(snap.state, { id, afterId: after || null, from, startPerson: start }, { today: snap.today, names: nameMap });
      return Array.from({ length: 8 }, (_, i) => r.state.shifts.find((x) => x.date === addDays(from, i))).filter(Boolean).map((x) => ({ date: x!.date, who: x!.assignee }));
    } catch (e) { return (e as Error).message; }
  })();
  const submit = async () => {
    if (trimmed.length < 1 || trimmed.length > 30) return setErr('Escribe un nombre de 1 a 30 caracteres.');
    if (Object.values(people).some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) return setErr('Ya existe alguien con ese nombre.');
    if (from < snap.today) return setErr('La fecha no puede ser pasada.');
    setErr('');
    const members: Participant[] = newOrder.map((pid, i) => pid === id
      ? { id, name: trimmed, color, inRotation: true, sortOrder: i + 1 }
      : { ...people[pid]!, sortOrder: i + 1 });
    const ok = await run((s, c) => addRotationMember(s, { id, afterId: after || null, from, startPerson: start }, { ...c, names: nameMap }),
      `${trimmed} se incorporó a la rotación.`, undefined, members);
    if (ok) onClose();
  };
  return (
    <Dialog title="Añadir integrante" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field">Nombre<input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} data-autofocus placeholder="Alejandro" /></label>
        <div className="field">Color
          <div className="row wrap">{COLORS.map((c) => (
            <label key={c} className="opt" style={{ padding: 4 }}><input type="radio" name="col" checked={color === c} onChange={() => setColor(c)} aria-label={c} /><span className="avatar sm" style={{ ['--c' as string]: c }} /></label>
          ))}</div>
        </div>
        <label className="field">Va después de
          <select value={after} onChange={(e) => setAfter(e.target.value)}>
            {order.map((pid) => <option key={pid} value={pid}>{people[pid]?.name}{pid === order[order.length - 1] ? ' (al final)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Desde el día<input type="date" min={snap.today} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Ese día cocina
          <select value={start} onChange={(e) => { setStartAuto(false); setStartPerson(e.target.value); }}>
            {newOrder.map((pid) => <option key={pid} value={pid}>{pid === id ? (trimmed || 'El nuevo integrante') : people[pid]?.name}</option>)}
          </select>
        </label>
        {preview && (
          <div className="note" data-testid="member-preview">
            <strong>Así quedaría:</strong>{' '}
            {typeof preview === 'string' ? preview : preview.map((x) => `${x.date.slice(8)}: ${nameMap[x.who] ?? x.who}`).join(' · ')}
          </div>
        )}
        <p className="muted small">Se reconstruye la rotación futura desde esa fecha (excepciones de mamá y coberturas posteriores se descartan; los viajes registrados se respetan).</p>
        {err && <p className="error-text" role="alert">{err}</p>}
        <div className="row between"><button type="button" className="btn" onClick={onClose} disabled={busy}>Cancelar</button><button className="btn primary" disabled={busy || !trimmed}>{busy ? 'Guardando…' : 'Añadir a la rotación'}</button></div>
      </form>
    </Dialog>
  );
}
