import { useEffect, useMemo, useState } from 'react';
import { firstOfMonth } from '../domain';
import { Route, parseRoute, useController } from '../data/controller';
import { Calendar } from './Calendar';
import { DayPanel } from './DayPanel';
import { AbsenceDialog, CancelAbsenceDialog, CancelCompDialog, CompDialog } from './Dialogs';
import { AbsencesView } from './AbsencesView';
import { HistoryView } from './HistoryView';
import { StatsView } from './StatsView';
import { SettingsView, SetupView } from './SettingsView';
import { Summary } from './Summary';
import { Login } from './Login';
import { Icon, People, Spinner, Toast } from './common';

type Tab = 'calendar' | 'absences' | 'history' | 'stats' | 'settings';

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return <Shell key={route.kind === 'visitor' ? route.token : 'admin'} route={route} />;
}

function Shell({ route }: { route: Route }) {
  const c = useController(route);
  const { snap, phase } = c;
  const [tab, setTab] = useState<Tab>('calendar');
  const [month, setMonth] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | { kind: 'absence'; date: string } | { kind: 'schedule'; id: string } | { kind: 'cancelComp'; id: string } | { kind: 'cancelAbs'; id: string }>(null);

  const people: People = useMemo(() => Object.fromEntries((snap?.participants ?? []).map((p) => [p.id, p])), [snap]);

  if (phase === 'config') {
    return <div className="center-screen"><div className="card auth-card"><h1>Falta configurar Supabase</h1>
      <p className="muted">Copia <code>.env.example</code> como <code>.env.local</code>, rellena <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> y reinicia <code>npm run dev</code>. Mira el README, paso 6.</p></div></div>;
  }
  if (phase === 'loading') return <div className="center-screen"><Spinner /></div>;
  if (phase === 'login') return <Login onDone={() => void c.reload()} />;
  if (phase === 'forbidden') {
    return <div className="center-screen"><div className="card auth-card"><h1>Sin permiso de administrador</h1>
      <p className="muted">Esta cuenta existe pero no está autorizada para administrar. Añádela a la tabla <code>admins</code> (README, paso 9) o entra con otra cuenta.</p>
      <button className="btn" onClick={() => void c.logout()}>Cerrar sesión</button></div></div>;
  }
  if (phase === 'error' || !snap) {
    return <div className="center-screen"><div className="card auth-card"><h1>No se pudo cargar</h1><p className="error-text" role="alert">{c.error}</p>
      <div className="row wrap"><button className="btn primary" onClick={() => void c.reload()}>Reintentar</button>
        {route.kind === 'admin' && <button className="btn" onClick={() => void c.logout()}>Cerrar sesión</button>}</div></div></div>;
  }

  const admin = snap.role === 'admin';
  if (admin && snap.state.shifts.length === 0) {
    return <><SetupView snap={snap} people={people} busy={c.busy} run={c.run} /><Toast toast={c.toast} /></>;
  }

  const shownMonth = month ?? firstOfMonth(snap.today);
  const showHistory = admin || snap.settings.showHistory;
  const tabs: [Tab, string][] = [['calendar', 'Calendario'], ['absences', 'Ausencias'], ...(showHistory ? ([['history', 'Historial'], ['stats', 'Estadísticas']] as [Tab, string][]) : []), ...(admin ? ([['settings', 'Ajustes']] as [Tab, string][]) : [])];

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden="true"><Icon name="check" size={18} /></span>Cocina</div>
        <span className="badge-role">{admin ? 'Administrador' : 'Solo lectura'}</span>
        <div className="grow" />
        <div className="tabs" role="tablist" aria-label="Secciones">
          {tabs.map(([k, label]) => <button key={k} role="tab" className="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{label}</button>)}
        </div>
      </header>

      <main>
        {tab === 'calendar' && (
          <div className="layout">
            <Calendar month={shownMonth} state={snap.state} people={people} today={snap.today} canEdit={admin} selected={selected} onSelect={setSelected} onMonth={setMonth} />
            <Summary snap={snap} people={people} />
          </div>
        )}
        {tab === 'absences' && (
          <AbsencesView snap={snap} people={people} admin={admin}
            onNew={() => setDialog({ kind: 'absence', date: snap.today })}
            onCancelAbsence={(id) => setDialog({ kind: 'cancelAbs', id })}
            onSchedule={(id) => setDialog({ kind: 'schedule', id })}
            onCancelComp={(id) => setDialog({ kind: 'cancelComp', id })} />
        )}
        {tab === 'history' && showHistory && <HistoryView snap={snap} people={people} admin={admin} />}
        {tab === 'stats' && showHistory && <StatsView snap={snap} people={people} />}
        {tab === 'settings' && admin && (
          <SettingsView snap={snap} people={people} busy={c.busy} run={c.run} saveSettings={c.saveSettings} reload={c.reload} notify={c.notify} onLogout={() => void c.logout()} />
        )}
      </main>

      {selected && !dialog && (
        <DayPanel date={selected} snap={snap} people={people} busy={c.busy} run={c.run} onClose={() => setSelected(null)}
          onAbsence={(date) => { setSelected(null); setDialog({ kind: 'absence', date }); }}
          onSchedule={(id) => { setSelected(null); setDialog({ kind: 'schedule', id }); }} />
      )}
      {admin && dialog?.kind === 'absence' && <AbsenceDialog snap={snap} people={people} busy={c.busy} run={c.run} initialDate={dialog.date} onClose={() => setDialog(null)} />}
      {admin && dialog?.kind === 'schedule' && <CompDialog snap={snap} people={people} busy={c.busy} run={c.run} compId={dialog.id} onClose={() => setDialog(null)} />}
      {admin && dialog?.kind === 'cancelComp' && <CancelCompDialog compId={dialog.id} busy={c.busy} run={c.run} onClose={() => setDialog(null)} />}
      {admin && dialog?.kind === 'cancelAbs' && <CancelAbsenceDialog absenceId={dialog.id} people={people} snap={snap} busy={c.busy} run={c.run} onClose={() => setDialog(null)} />}
      <Toast toast={c.toast} />
    </div>
  );
}
