import { useState } from 'react';
import { MOM, addDays, rebuildFuture, setupRotation, formatLong } from '../domain';
import { Snapshot, rotateShareToken } from '../data/repository';
import { Confirm, Icon, People } from './common';
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
  const [from, setFrom] = useState(snap.today);
  const [start, setStart] = useState(snap.state.order[0] ?? '');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [confirmRebuild, setConfirmRebuild] = useState(false);

  const copy = async () => {
    try { await navigator.clipboard.writeText(url); notify('ok', 'Enlace copiado.'); } catch { notify('err', 'No se pudo copiar; selecciónalo manualmente.'); }
  };
  const regenerate = async () => {
    setWorking(true);
    try { await rotateShareToken(); await reload(); notify('ok', 'Enlace nuevo generado. El anterior ya no funciona.'); setConfirmToken(false); }
    catch (e) { notify('err', (e as Error).message); } finally { setWorking(false); }
  };
  const doRebuild = async () => {
    const ok = await run((s, c) => rebuildFuture(s, from, start, reason, c), 'Rotación reconstruida.');
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
        <h2>Reglas de la rotación</h2>
        <p className="muted small">Orden: {snap.state.order.map((id) => people[id]?.name).join(' → ')} → … y se repite. Zona horaria: America/Guayaquil (la decide el servidor). Mamá no forma parte del orden: sus excepciones desplazan un día toda la rotación posterior.</p>
        <p className="muted small">Viajes: quien está de viaje sale de la fila; los siguientes se adelantan y quien viajó recupera su turno al volver (seguidos si perdió más de uno). Si mamá cubre el turno de quien viaja, es un reemplazo y nada se mueve. No hay azar.</p>
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Reiniciar la rotación desde una fecha</summary>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="note warn">Descarta excepciones de mamá y coberturas posteriores a esa fecha y vuelve a generar la secuencia. Los días pasados nunca se tocan. Úsalo solo para corregir el orden.</div>
            <div className="row wrap">
              <label className="field grow">Desde<input type="date" value={from} min={snap.today} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field grow">Empieza<select value={start} onChange={(e) => setStart(e.target.value)}>{snap.state.order.map((id) => <option key={id} value={id}>{people[id]?.name}</option>)}</select></label>
            </div>
            <label className="field">Motivo <span className="hint">Obligatorio</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
            {err && <p className="error-text" role="alert">{err}</p>}
            <button className="btn danger" onClick={() => { if (!reason.trim()) return setErr('Indica el motivo.'); setErr(''); setConfirmRebuild(true); }}>Reconstruir rotación</button>
          </div>
        </details>
      </section>

      <section className="card row between wrap">
        <div><strong>Sesión de administrador</strong><div className="muted small">Hoy es {formatLong(snap.today)} (hora de Ecuador, según el servidor).</div></div>
        <button className="btn" onClick={onLogout}><Icon name="logout" /> Cerrar sesión</button>
      </section>

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
