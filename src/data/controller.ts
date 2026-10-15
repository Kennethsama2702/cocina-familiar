import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ctx, DomainError, OpResult, Participant, Plan, State, addDays, buildPlan, diffDays, housekeeping, isEmptyPlan, lastDate,
} from '../domain';
import { AppError, Snapshot, applyPlan, currentSession, friendlyError, isAdmin, loadAdmin, loadVisitor, signOut } from './repository';
import { configured } from '../lib/supabase';

export type Route = { kind: 'visitor'; token: string } | { kind: 'admin' };

export function parseRoute(hash: string): Route {
  const m = /^#\/ver\/([A-Za-z0-9_-]{32,128})$/.exec(hash);
  return m ? { kind: 'visitor', token: m[1]! } : { kind: 'admin' };
}

export type Phase = 'config' | 'loading' | 'login' | 'forbidden' | 'ready' | 'error';

export const HORIZON_DAYS = 730;
const MIN_FUTURE_DAYS = 365;

export function useController(route: Route) {
  const [phase, setPhase] = useState<Phase>(configured ? 'loading' : 'config');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string; id: number } | null>(null);
  const toastId = useRef(0);

  const notify = useCallback((kind: 'ok' | 'err', text: string) => {
    setToast({ kind, text, id: ++toastId.current });
  }, []);

  const load = useCallback(async (): Promise<Snapshot | null> => {
    if (!configured) return null;
    try {
      let s: Snapshot;
      if (route.kind === 'visitor') {
        s = await loadVisitor(route.token);
      } else {
        const session = await currentSession();
        if (!session) { setPhase('login'); return null; }
        if (!(await isAdmin())) { setPhase('forbidden'); return null; }
        s = await loadAdmin();
        // Mantenimiento: ampliar el calendario y cerrar compensaciones cuyo turno ya pasó.
        if (s.state.shifts.length > 0) {
          const ctx = makeCtx(s);
          // Solo se amplía cuando quedan menos de un año de calendario (evita escrituras diarias innecesarias).
          const remaining = diffDays(s.today, lastDate(s.state));
          const horizon = remaining < MIN_FUTURE_DAYS ? addDays(s.today, HORIZON_DAYS) : lastDate(s.state);
          const grown = housekeeping(s.state, ctx, horizon);
          const plan = buildPlan(s.state, grown, null, ctx);
          if (!isEmptyPlan(plan)) {
            try {
              await applyPlan(plan, s.settings.version);
              s = await loadAdmin();
            } catch (e) {
              if (friendlyError(e).code !== 'STALE_VERSION') throw e;
              s = await loadAdmin();
            }
          }
        }
      }
      setSnap(s);
      setError(null);
      setPhase('ready');
      return s;
    } catch (e) {
      const fe = friendlyError(e);
      setError(fe.message);
      setPhase('error');
      return null;
    }
  }, [route]);

  useEffect(() => {
    if (configured) { setPhase('loading'); void load(); }
  }, [load]);

  // Refresco periódico y al volver a la pestaña (varios dispositivos).
  useEffect(() => {
    if (phase !== 'ready') return;
    const refresh = () => { if (document.visibilityState === 'visible' && !busy) void load(); };
    const t = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', refresh); };
  }, [phase, load, busy]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.kind === 'err' ? 7000 : 3800);
    return () => window.clearTimeout(t);
  }, [toast]);

  const names = useMemo(() => Object.fromEntries((snap?.participants ?? []).map((p) => [p.id, p.name])), [snap]);

  const ctx: Ctx | null = snap ? { today: snap.today, names } : null;

  /** Ejecuta una operación de dominio y la guarda de forma atómica en el servidor. */
  const run = useCallback(async (op: (state: State, ctx: Ctx) => OpResult, okText: string, settings?: Plan['settings']): Promise<boolean> => {
    if (!snap || snap.role !== 'admin') return false;
    setBusy(true);
    try {
      const c = makeCtx(snap);
      const result = op(snap.state, c);
      const plan = buildPlan(snap.state, result.state, result.event, c);
      if (settings) plan.settings = settings;
      await applyPlan(plan, snap.settings.version);
      await load();
      notify('ok', okText);
      return true;
    } catch (e) {
      const fe = e instanceof DomainError ? new AppError(e.code, e.message) : friendlyError(e);
      notify('err', fe.message);
      if (fe.code === 'STALE_VERSION') await load();
      return false;
    } finally {
      setBusy(false);
    }
  }, [snap, load, notify]);

  /** Guarda cambios de configuración (sin operación de dominio). */
  const saveSettings = useCallback(async (settings: { show_history?: boolean; show_reasons?: boolean }, summary: string): Promise<boolean> => {
    if (!snap) return false;
    setBusy(true);
    try {
      await applyPlan({
        shifts: [], deleteDates: [], absences: [], comps: [],
        event: { type: 'settings', summary, reason: null, date: null, affected: [] },
        settings,
      }, snap.settings.version);
      await load();
      notify('ok', 'Ajustes guardados.');
      return true;
    } catch (e) {
      notify('err', friendlyError(e).message);
      return false;
    } finally { setBusy(false); }
  }, [snap, load, notify]);

  const logout = useCallback(async () => { await signOut(); setSnap(null); setPhase('login'); }, []);

  return { phase, snap, error, busy, toast, notify, run, saveSettings, reload: load, logout, setPhase, ctx, names };
}

export function makeCtx(s: Snapshot): Ctx {
  return { today: s.today, names: Object.fromEntries(s.participants.map((p: Participant) => [p.id, p.name])) };
}
