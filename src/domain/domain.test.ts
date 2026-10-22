import { describe, expect, it } from 'vitest';
import {
  DomainError,
  MOM,
  State,
  addDays,
  addMomException,
  assertInvariants,
  buildPlan,
  cancelAbsence,
  cancelCompensation,
  cancelMomException,
  changeAssignee,
  compViews,
  computeStats,
  createAbsence,
  getShift,
  housekeeping,
  markShift,
  momCoversAbsentTurn,
  previewAbsence,
  proposeCompensation,
  rebuildFuture,
  scheduleCompensation,
  setupRotation,
  isAbsent,
  skipDay,
  undoSkipDay,
} from './index';

const ORDER = ['kenneth', 'eric', 'michael', 'marco'];
const [K, E, M, MA] = ORDER as [string, string, string, string];

const ctxOf = (today: string) => ({ today });

function boot(today = '2026-10-12', first = K, days = 200): { state: State; ctx: { today: string } } {
  const ctx = ctxOf(today);
  return { state: setupRotation(ORDER, first, ctx, days).state, ctx };
}

const who = (s: State, d: string) => getShift(s, d)!.assignee;
const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof DomainError ? e.code : `OTHER:${String(e)}`;
  }
};

describe('rotación base', () => {
  it('sigue K → E → M → Marco indefinidamente', () => {
    const { state } = boot();
    const seq = state.shifts.slice(0, 9).map((s) => s.assignee);
    expect(seq).toEqual([K, E, M, MA, K, E, M, MA, K]);
  });

  it('continúa sin reiniciarse al cambiar de mes y de año', () => {
    const { state, ctx } = boot('2026-12-29', K, 10);
    const grown = housekeeping(state, ctx, '2027-02-10');
    // 29 dic = K, 30 = E, 31 = M, 1 ene = MA, 2 ene = K ...
    expect(who(grown, '2026-12-31')).toBe(M);
    expect(who(grown, '2027-01-01')).toBe(MA);
    expect(who(grown, '2027-01-02')).toBe(K);
    assertInvariants(grown);
    const seq = grown.shifts.map((s) => s.slot!);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBe(ORDER[(ORDER.indexOf(seq[i - 1]!) + 1) % 4]);
    }
  });

  it('permite elegir quién inicia', () => {
    const { state } = boot('2026-10-12', M);
    expect(state.shifts.slice(0, 5).map((s) => s.assignee)).toEqual([M, MA, K, E, M]);
  });
});

describe('excepción de mamá', () => {
  it('reproduce el ejemplo del enunciado', () => {
    const { state, ctx } = boot('2026-10-12'); // lunes
    const r = addMomException(state, '2026-10-14', null, ctx).state; // miércoles
    const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'];
    expect(week.map((d) => who(r, d))).toEqual([K, E, MOM, M, MA, K, E, M]);
  });

  it('desplaza UNA sola vez por intervención y se acumula', () => {
    const { state, ctx } = boot('2026-10-12');
    const once = addMomException(state, '2026-10-14', null, ctx).state;
    const twice = addMomException(once, '2026-10-20', null, ctx).state;
    // Sin mamá, el 2026-10-30 sería (18 días desde K) → índice 18 % 4 = 2 → M
    expect(who(state, '2026-10-30')).toBe(M);
    expect(who(once, '2026-10-30')).toBe(E); // 1 desplazamiento → un puesto atrás
    expect(who(twice, '2026-10-30')).toBe(K); // 2 desplazamientos
    expect(once.shifts.filter((s) => s.kind === 'mom')).toHaveLength(1);
    expect(twice.shifts.filter((s) => s.kind === 'mom')).toHaveLength(2);
    assertInvariants(twice);
  });

  it('el desplazamiento persiste entre meses y años', () => {
    const { state, ctx } = boot('2026-12-30', K, 60);
    const r = addMomException(state, '2026-12-31', null, ctx).state;
    expect(r.shifts.slice(0, 5).map((s) => s.assignee)).toEqual([K, MOM, E, M, MA]);
    expect(who(r, '2027-01-02')).toBe(M);
    assertInvariants(r);
  });

  it('no permite dos excepciones el mismo día', () => {
    const { state, ctx } = boot();
    const r = addMomException(state, '2026-10-14', null, ctx).state;
    expect(code(() => addMomException(r, '2026-10-14', null, ctx))).toBe('DUPLICATE');
  });

  it('cancelarla restituye exactamente la rotación anterior', () => {
    const { state, ctx } = boot();
    const withMom = addMomException(state, '2026-10-14', 'visita', ctx).state;
    const back = cancelMomException(withMom, '2026-10-14', null, ctx).state;
    const trim = (s: State) => s.shifts.slice(0, 190).map((x) => [x.date, x.assignee, x.kind]);
    expect(trim(back)).toEqual(trim(state));
  });

  it('permite excepción hoy, pero nunca en el pasado', () => {
    const { state } = boot('2026-10-12');
    const today = ctxOf('2026-10-13');
    expect(code(() => addMomException(state, '2026-10-13', null, today))).toBeNull();
    expect(code(() => addMomException(state, '2026-10-12', null, today))).toBe('PAST_LOCKED');
  });
});

describe('bloqueo de días pasados', () => {
  it('rechaza toda operación sobre fechas anteriores a hoy', () => {
    const { state } = boot('2026-10-01');
    const ctx = ctxOf('2026-10-13');
    expect(code(() => changeAssignee(state, { date: '2026-10-05', newAssignee: E, reason: 'x' }, ctx))).toBe('PAST_LOCKED');
    expect(code(() => addMomException(state, '2026-10-05', null, ctx))).toBe('PAST_LOCKED');
    expect(code(() => markShift(state, { date: '2026-10-05', status: 'done' }, ctx))).toBe('INVALID');
    expect(code(() => rebuildFuture(state, '2026-10-05', K, 'x', ctx))).toBe('PAST_LOCKED');
    expect(code(() => previewAbsence(state, { person: K, start: '2026-10-01', end: '2026-10-05', reason: null }, [], ctx))).toBe('PAST_LOCKED');
  });

  it('una ausencia en curso solo toca desde hoy en adelante', () => {
    const { state } = boot('2026-10-01', K, 60);
    const ctx = ctxOf('2026-10-13');
    const before = state.shifts.filter((s) => s.date < '2026-10-13').map((s) => ({ ...s }));
    const r = createAbsence(state, { person: K, start: '2026-10-10', end: '2026-10-20', reason: 'viaje' }, [], ctx).state;
    expect(r.shifts.filter((s) => s.date < '2026-10-13')).toEqual(before);
  });

  it('buildPlan aborta si un cambio tocara el pasado (red de seguridad)', () => {
    const { state } = boot('2026-10-01');
    const ctx = ctxOf('2026-10-13');
    const bad = { ...state, shifts: state.shifts.map((s) => (s.date === '2026-10-05' ? { ...s, assignee: E } : s)) };
    expect(code(() => buildPlan(state, bad, null, ctx))).toBe('PAST_LOCKED');
  });

  it('el día actual sigue siendo editable', () => {
    const { state } = boot('2026-10-12');
    const ctx = ctxOf('2026-10-13');
    expect(code(() => changeAssignee(state, { date: '2026-10-13', newAssignee: M, reason: 'cambio' }, ctx))).toBeNull();
  });
});

describe('cambio manual y trazabilidad', () => {
  it('exige motivo y conserva el responsable original', () => {
    const { state, ctx } = boot();
    expect(code(() => changeAssignee(state, { date: '2026-10-14', newAssignee: E, reason: '  ' }, ctx))).toBe('INVALID');
    const r = changeAssignee(state, { date: '2026-10-14', newAssignee: E, reason: 'Examen de Michael' }, ctx);
    const s = getShift(r.state, '2026-10-14')!;
    expect(s.assignee).toBe(E);
    expect(s.original).toBe(M);
    expect(s.kind).toBe('manual');
    expect(r.event.reason).toBe('Examen de Michael');
    const plan = buildPlan(state, r.state, r.event, ctx);
    expect(plan.event!.affected.map((a) => a.date)).toEqual(['2026-10-14']);
    expect(plan.event!.affected[0]).toEqual({ date: '2026-10-14', from: M, to: E });
  });

  it('volver al original limpia el cambio sin dejar compensaciones', () => {
    const { state, ctx } = boot();
    const a = changeAssignee(state, { date: '2026-10-14', newAssignee: E, reason: 'x', createCompensation: true }, ctx).state;
    expect(a.comps).toHaveLength(1);
    const b = changeAssignee(a, { date: '2026-10-14', newAssignee: M, reason: 'se arregló' }, ctx).state;
    expect(getShift(b, '2026-10-14')!.kind).toBe('rotation');
    expect(b.comps.filter((c) => c.status !== 'cancelled')).toHaveLength(0);
  });

  it('no asigna a una persona ausente', () => {
    const { state, ctx } = boot();
    const withAbs = createAbsence(state, { person: E, start: '2026-10-20', end: '2026-10-22', reason: null }, [], ctx).state;
    expect(code(() => changeAssignee(withAbs, { date: '2026-10-21', newAssignee: E, reason: 'x' }, ctx))).toBe('UNAVAILABLE');
  });
});

describe('registro de realización', () => {
  it('distingue asignado de realizado y exige motivo si difieren', () => {
    const { state } = boot('2026-10-12');
    const ctx = ctxOf('2026-10-12');
    expect(code(() => markShift(state, { date: '2026-10-12', status: 'done', performedBy: E }, ctx))).toBe('INVALID');
    const r = markShift(state, { date: '2026-10-12', status: 'done', performedBy: E, reason: 'Kenneth tenía clase' }, ctx).state;
    const s = getShift(r, '2026-10-12')!;
    expect([s.assignee, s.original, s.performedBy, s.status]).toEqual([K, K, E, 'done']);
  });

  it('si mamá limpió hay que usar la excepción (para desplazar la rotación)', () => {
    const { state } = boot('2026-10-12');
    expect(code(() => markShift(state, { date: '2026-10-12', status: 'done', performedBy: MOM, reason: 'x' }, ctxOf('2026-10-12')))).toBe('INVALID');
  });

  it('solo se puede registrar el mismo día', () => {
    const { state } = boot('2026-10-12');
    expect(code(() => markShift(state, { date: '2026-10-14', status: 'done' }, ctxOf('2026-10-12')))).toBe('INVALID');
  });
});

/** Secuencia de responsables a partir de un día, p. ej. "E M K Ma K". */
const seq = (s: State, from: string, n: number) => Array.from({ length: n }, (_, i) => who(s, addDays(from, i)));

describe('viajes: los siguientes se adelantan y quien viaja recupera su turno al volver', () => {
  // Lunes 19/10/2026: K, E, M, Ma, K(vie 23), E(sáb 24), M(dom 25), Ma(lun 26), K(mar 27), E, M, Ma…
  const MON = '2026-10-19';
  const FRI = '2026-10-23';
  const trip = (end: string) => ({ person: K, start: FRI, end, reason: 'Viaje' });

  it('ejemplo del enunciado: viaje vie–sáb → E, M, luego K al volver, y desde el lunes el patrón original', () => {
    const { state, ctx } = boot(MON);
    const r = createAbsence(state, trip('2026-10-24'), [], ctx).state;
    expect(seq(r, FRI, 6)).toEqual([E, M, K, MA, K, E]); // vie sáb dom lun mar mié
    expect(getShift(r, FRI)!.original).toBe(K); // se conserva el original
    expect(getShift(r, FRI)!.kind).toBe('cover');
    expect(getShift(r, '2026-10-25')!.kind).toBe('compensation'); // K recupera su turno
    // A partir del lunes todo coincide con el patrón sin viaje
    for (let i = 3; i < 150; i++) expect(who(r, addDays(FRI, i))).toBe(who(state, addDays(FRI, i)));
    // No se crean deudas: se recupera en el acto
    expect(r.comps).toHaveLength(0);
    assertInvariants(r);
  });

  it('viaje de un solo día: intercambio simple (E el viernes, K el sábado) y nada más cambia', () => {
    const { state, ctx } = boot(MON);
    const r = createAbsence(state, trip(FRI), [], ctx).state;
    expect(seq(r, FRI, 4)).toEqual([E, K, M, MA]);
    for (let i = 2; i < 150; i++) expect(who(r, addDays(FRI, i))).toBe(who(state, addDays(FRI, i)));
  });

  it('viaje largo con 2 turnos perdidos: los recupera seguidos y luego vuelve el patrón original', () => {
    const { state, ctx } = boot(MON);
    const r = createAbsence(state, trip('2026-10-27'), [], ctx).state; // vie 23 → mar 27: pierde vie y mar
    expect(seq(r, FRI, 7)).toEqual([E, M, MA, E, M, K, K]); // vie…jue; K el miércoles 28 y jueves 29
    for (let i = 7; i < 150; i++) expect(who(r, addDays(FRI, i))).toBe(who(state, addDays(FRI, i)));
    expect(r.shifts.filter((x) => x.kind === 'compensation')).toHaveLength(2);
    // Nadie ausente tiene un turno pendiente
    for (const x of r.shifts) if (x.status === 'scheduled') expect(isAbsent(r, x.assignee, x.date)).toBe(false);
  });

  it('si mamá cubre el turno de quien viaja es un REEMPLAZO: el patrón no se mueve', () => {
    const { state, ctx } = boot(MON);
    const r = createAbsence(state, trip('2026-10-24'), [FRI], ctx).state;
    expect(seq(r, FRI, 6)).toEqual([MOM, E, M, MA, K, E]); // E sáb, M dom, Ma lun, K mar
    expect(getShift(r, FRI)!.original).toBe(K);
    for (let i = 1; i < 150; i++) expect(who(r, addDays(FRI, i))).toBe(who(state, addDays(FRI, i)));
  });

  it('también se puede indicar después, desde el turno ya adelantado', () => {
    const { state, ctx } = boot(MON);
    const trip1 = createAbsence(state, trip('2026-10-24'), [], ctx).state;
    const r = momCoversAbsentTurn(trip1, FRI, ctx).state;
    expect(seq(r, FRI, 6)).toEqual([MOM, E, M, MA, K, E]);
    expect(code(() => momCoversAbsentTurn(trip1, '2026-10-25', ctx))).toBe('INVALID'); // ese día K no está de viaje
  });

  it('mamá hace la cocina a alguien que NO viaja: todo lo posterior se corre un día', () => {
    const { state, ctx } = boot(MON);
    const r0 = createAbsence(state, trip('2026-10-24'), [], ctx).state; // vie E, sáb M, dom K, lun Ma, mar K
    const r = addMomException(r0, '2026-10-24', null, ctx).state; // mamá el sábado (turno de M)
    expect(seq(r, FRI, 6)).toEqual([E, MOM, M, K, MA, K]); // M pasa al domingo y K recupera el lunes
    assertInvariants(r);
  });

  it('cancelar el viaje devuelve exactamente el patrón original', () => {
    const { state, ctx } = boot(MON);
    const r0 = createAbsence(state, trip('2026-10-27'), [], ctx).state;
    const r = cancelAbsence(r0, r0.absences[0]!.id, ctx).state;
    expect(r.shifts.map((x) => [x.date, x.assignee, x.kind])).toEqual(state.shifts.map((x) => [x.date, x.assignee, x.kind]));
  });

  it('la vista previa muestra los cambios y los turnos que mamá podría cubrir, sin guardar nada', () => {
    const { state, ctx } = boot(MON);
    const before = JSON.stringify(state);
    const p = previewAbsence(state, trip('2026-10-27'), [], ctx);
    expect(p.lost).toEqual([FRI, '2026-10-27']);
    expect(p.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify(state)).toBe(before);
    expect(code(() => previewAbsence(state, trip('2026-10-27'), ['2026-10-24'], ctx))).toBe('INVALID'); // no es turno de K
  });

  it('no duplica nada: segundo registro rechazado, housekeeping y repetición son idempotentes', () => {
    const { state, ctx } = boot(MON, K, 300);
    const r = createAbsence(state, trip('2026-10-24'), [], ctx).state;
    expect(code(() => createAbsence(r, trip('2026-10-24'), [], ctx))).toBe('DUPLICATE');
    const again = housekeeping(r, ctx, '2027-06-01');
    expect(again.shifts.slice(0, 300).map((x) => [x.date, x.assignee, x.kind])).toEqual(r.shifts.map((x) => [x.date, x.assignee, x.kind]));
    expect(again.comps).toHaveLength(0);
  });

  it('dos viajeros a la vez: nadie ausente cocina y cada uno recupera lo suyo', () => {
    const { state, ctx } = boot(MON);
    let r = createAbsence(state, { person: K, start: FRI, end: '2026-10-24', reason: null }, [], ctx).state;
    r = createAbsence(r, { person: E, start: '2026-10-24', end: '2026-10-26', reason: null }, [], ctx).state;
    for (const x of r.shifts) if (x.status === 'scheduled') expect(isAbsent(r, x.assignee, x.date)).toBe(false);
    // Conteo total conservado: pasada la ventana cada persona lleva los mismos turnos que sin viaje
    const count = (st: State, p: string) => st.shifts.slice(0, 20).filter((x) => x.assignee === p).length;
    for (const p of [K, E, M, MA]) expect(count(r, p)).toBe(count(state, p));
  });

  it('cuando todos están ausentes cubre mamá', () => {
    const { state, ctx } = boot('2026-10-12');
    let s = state;
    for (const p of [E, MA, K, M]) s = createAbsence(s, { person: p, start: '2026-10-14', end: '2026-10-14', reason: null }, [], ctx).state;
    expect(who(s, '2026-10-14')).toBe(MOM);
    assertInvariants(s);
  });

  it('una excepción de mamá que empuja un turno a un día de ausencia se recalcula', () => {
    const { state, ctx } = boot('2026-10-12');
    const withAbs = createAbsence(state, { person: E, start: '2026-10-14', end: '2026-10-14', reason: null }, [], ctx).state;
    const r = addMomException(withAbs, '2026-10-13', null, ctx).state; // Eric pasaría al 14, ausente
    expect(isAbsent(r, who(r, '2026-10-14'), '2026-10-14')).toBe(false);
    assertInvariants(r);
  });

  describe('programar compensaciones', () => {
    function withDebt() {
      const { state, ctx } = boot('2026-10-12', K, 120);
      // Compensación manual: Michael cede su turno del 14 a Eric y queda debiéndole uno.
      const r = changeAssignee(state, { date: '2026-10-14', newAssignee: E, reason: 'Examen', createCompensation: true }, ctx).state;
      return { state: r, ctx, comp: r.comps[0]! };
    }

    it('propone fechas del acreedor, posteriores, ordenadas por menor penalización', () => {
      const { state, ctx, comp } = withDebt();
      const p = proposeCompensation(state, comp.id, ctx);
      expect(p.options.length).toBeGreaterThan(0);
      for (const o of p.options) {
        const row = getShift(state, o.date)!;
        expect(row.assignee).toBe(E);
        expect(o.date > '2026-10-14').toBe(true);
      }
      const pens = p.options.map((o) => o.penalty);
      expect(pens).toEqual([...pens].sort((a, b) => a - b));
      // Michael va justo después de Eric en la rotación: siempre quedaría pegado → no es "clara", hay que elegir.
      expect(p.clear).toBe(false);
    });

    it('marca la propuesta como clara cuando evita turnos consecutivos', () => {
      const { state: s0, ctx } = boot('2026-10-12', K, 120);
      // Kenneth cede su turno del 16 a Michael y queda debiéndole uno.
      const r = changeAssignee(s0, { date: '2026-10-16', newAssignee: M, reason: 'Clase', createCompensation: true }, ctx).state;
      const p = proposeCompensation(r, r.comps[0]!.id, ctx);
      expect(p.clear).toBe(true);
      expect(p.options[0]!.penalty).toBeLessThan(2);
    });

    it('programar cambia un solo turno, no rompe el patrón y no se puede duplicar', () => {
      const { state, ctx, comp } = withDebt();
      const date = proposeCompensation(state, comp.id, ctx).options[0]!.date;
      const r = scheduleCompensation(state, comp.id, date, ctx).state;
      const changed = r.shifts.filter((s, i) => s.assignee !== state.shifts[i]!.assignee);
      expect(changed.map((s) => s.date)).toEqual([date]);
      const s = getShift(r, date)!;
      expect([s.assignee, s.original, s.kind]).toEqual([M, E, 'compensation']);
      expect(r.comps[0]!.status).toBe('scheduled');
      expect(code(() => scheduleCompensation(r, comp.id, date, ctx))).toBe('DUPLICATE');
      expect(code(() => proposeCompensation(r, comp.id, ctx))).toBe('CONFLICT');
    });

    it('se marca realizada al registrar la tarea el día de la compensación', () => {
      const { state, ctx, comp } = withDebt();
      const date = proposeCompensation(state, comp.id, ctx).options[0]!.date;
      const r = scheduleCompensation(state, comp.id, date, ctx).state;
      const later = { today: date };
      const done = markShift(r, { date, status: 'done' }, later).state;
      expect(done.comps[0]!.status).toBe('done');
      expect(compViews(done)[0]!.settleDate).toBe(date);
    });

    it('housekeeping da por realizada una compensación cuyo turno ya pasó', () => {
      const { state, ctx, comp } = withDebt();
      const date = proposeCompensation(state, comp.id, ctx).options[0]!.date;
      const r = scheduleCompensation(state, comp.id, date, ctx).state;
      const h = housekeeping(r, { today: addDays(date, 1) }, '2027-03-01');
      expect(h.comps[0]!.status).toBe('done');
    });

    it('si el deudor viaja ese día, la compensación vuelve a pendiente', () => {
      const { state, ctx, comp } = withDebt();
      const date = proposeCompensation(state, comp.id, ctx).options[0]!.date;
      const r = scheduleCompensation(state, comp.id, date, ctx).state;
      const away = createAbsence(r, { person: M, start: date, end: date, reason: null }, [], ctx).state;
      expect(away.comps.find((c) => c.id === comp.id)!.status).toBe('pending');
      expect(who(away, date)).toBe(E);
      assertInvariants(away);
    });

    it('cancelar una compensación programada devuelve el turno', () => {
      const { state, ctx, comp } = withDebt();
      const date = proposeCompensation(state, comp.id, ctx).options[0]!.date;
      const r = scheduleCompensation(state, comp.id, date, ctx).state;
      const c = cancelCompensation(r, comp.id, 'perdonada', ctx).state;
      expect(who(c, date)).toBe(E);
      expect(c.comps[0]!.status).toBe('cancelled');
      expect(code(() => cancelCompensation(c, comp.id, 'otra vez', ctx))).toBe('CONFLICT');
    });
  });
});

describe('estadísticas', () => {
  it('no cuentan dos veces una tarea reasignada y separan asignado de realizado', () => {
    // Kenneth viaja solo el 12 (hoy): Eric hace el 12 y Kenneth recupera el 13. Días: 12 E(orig K), 13 K(orig E), 14 M, 15 Ma, 16 K
    const { state: s0 } = boot('2026-10-12', K, 40);
    const day1 = ctxOf('2026-10-12');
    const s1 = createAbsence(s0, { person: K, start: '2026-10-12', end: '2026-10-12', reason: null }, [], day1).state;
    const ctx = ctxOf('2026-10-17');
    const stats = computeStats(s1, ctx);
    const totalAssigned = Object.values(stats).reduce((n, x) => n + x.assigned, 0);
    const totalDone = Object.values(stats).reduce((n, x) => n + x.done, 0);
    expect(totalAssigned).toBe(5);
    expect(totalDone).toBe(5); // ninguna tarea se cuenta dos veces
    expect(stats[K]!.assigned).toBe(2); // 12 y 16
    expect(stats[K]!.done).toBe(2); // el 13 (recuperado) y el 16
    expect(stats[K]!.notDoneByMe).toBe(1); // el 12 lo hizo Eric
    expect(stats[E]!.done).toBe(1); // solo el 12 (su turno original del 13 lo hizo Kenneth)
    expect(stats[E]!.coveredForOthers).toBe(1);
    expect(stats[K]!.owes + stats[E]!.isOwed).toBe(0); // no quedan deudas
  });

  it('un día en que nadie cocinó no cuenta ni como asignado ni como realizado', () => {
    const { state } = boot('2026-10-12', K, 20);
    const r = markShift(state, { date: '2026-10-12', status: 'skipped', reason: 'se cenó tarde' }, ctxOf('2026-10-12')).state;
    const st = computeStats(r, ctxOf('2026-10-13'));
    expect(st[K]!.assigned).toBe(0);
    expect(st[K]!.done).toBe(0);
    // El turno de Kenneth se hace al día siguiente y ahí sí cuenta
    const later = computeStats(r, ctxOf('2026-10-14'));
    expect(later[K]!.assigned).toBe(1);
    expect(later[K]!.done).toBe(1);
  });
});

describe('día en que nadie cocina: el turno pasa al día siguiente y todo se corre un día', () => {
  const MON = '2026-10-19';
  it('hoy nadie cocina → quien le tocaba lo hace mañana y el resto se corre un día', () => {
    const { state } = boot(MON); // K E M Ma K E M…
    const ctx = ctxOf(MON);
    const r = markShift(state, { date: MON, status: 'skipped', reason: 'Se cenó tarde' }, ctx).state;
    const s0 = getShift(r, MON)!;
    expect([s0.status, s0.assignee, s0.reason]).toEqual(['skipped', K, 'Se cenó tarde']);
    expect(seq(r, addDays(MON, 1), 6)).toEqual([K, E, M, MA, K, E]); // mar K, mié E, jue M, vie Ma…
    expect(r.shifts).toHaveLength(state.shifts.length + 1);
    assertInvariants(r);
  });

  it('se acumula con mamá y con otros días sin cocina', () => {
    const { state } = boot(MON);
    const ctx = ctxOf(MON);
    const a = skipDay(state, '2026-10-21', null, ctx).state; // mié (M) nadie cocina
    const b = addMomException(a, '2026-10-24', null, ctx).state;
    // sin nada, el 28/10 sería (9 días desde K) → E; con 2 desplazamientos → vuelve dos puestos atrás
    expect(who(state, '2026-10-28')).toBe(E);
    expect(who(b, '2026-10-28')).toBe(MA);
    assertInvariants(b);
  });

  it('un día futuro también se puede marcar y se puede deshacer, dejando todo como estaba', () => {
    const { state } = boot(MON);
    const ctx = ctxOf(MON);
    const a = skipDay(state, '2026-10-22', null, ctx).state;
    expect(getShift(a, '2026-10-22')!.status).toBe('skipped');
    const back = undoSkipDay(a, '2026-10-22', ctx).state;
    expect(back.shifts.map((x) => [x.date, x.assignee, x.kind, x.status])).toEqual(state.shifts.map((x) => [x.date, x.assignee, x.kind, x.status]));
  });

  it('deshacer desde "hoy" con markShift(scheduled) también funciona', () => {
    const { state } = boot(MON);
    const ctx = ctxOf(MON);
    const a = markShift(state, { date: MON, status: 'skipped' }, ctx).state;
    const back = markShift(a, { date: MON, status: 'scheduled' }, ctx).state;
    expect(back.shifts.map((x) => [x.date, x.assignee, x.status])).toEqual(state.shifts.map((x) => [x.date, x.assignee, x.status]));
  });

  it('no se puede en días pasados, sobre mamá ni sobre un día ya registrado', () => {
    const { state } = boot(MON);
    const ctx = ctxOf(MON);
    expect(code(() => skipDay(state, '2026-10-18', null, ctxOf('2026-10-20')))).toBe('PAST_LOCKED');
    const withMom = addMomException(state, '2026-10-21', null, ctx).state;
    expect(code(() => skipDay(withMom, '2026-10-21', null, ctx))).toBe('CONFLICT');
    const done = markShift(state, { date: MON, status: 'done' }, ctx).state;
    expect(code(() => skipDay(done, MON, null, ctx))).toBe('CONFLICT');
  });

  it('el turno trasladado conserva su responsable original y no duplica compensaciones', () => {
    const { state, ctx } = boot('2026-10-12', K, 60);
    const withComp = changeAssignee(state, { date: '2026-10-14', newAssignee: E, reason: 'Examen', createCompensation: true }, ctx).state;
    const skipped = skipDay(withComp, '2026-10-14', null, ctx).state;
    const rows = skipped.shifts.filter((x) => x.generatesComp);
    expect(rows).toHaveLength(1); // la compensación viaja con el turno trasladado
    expect(rows[0]!.date).toBe('2026-10-15');
    assertInvariants(skipped);
  });

  it('si el turno trasladado cae en un día de ausencia de esa persona, se recalcula sin asignar ausentes', () => {
    const { state, ctx } = boot(MON);
    const away = createAbsence(state, { person: K, start: '2026-10-20', end: '2026-10-20', reason: null }, [], ctx).state;
    const r = skipDay(away, MON, null, ctx).state; // el turno de K de hoy pasaría al martes 20, cuando K viaja
    for (const x of r.shifts) if (x.status === 'scheduled') expect(isAbsent(r, x.assignee, x.date)).toBe(false);
    assertInvariants(r);
  });
});

describe('invariantes bajo operaciones aleatorias (reproducible)', () => {
  function rng(seed: number) {
    let x = seed;
    return () => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    };
  }

  it('el calendario nunca queda contradictorio', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed);
      const ctx = ctxOf('2026-10-12');
      let state = setupRotation(ORDER, K, ctx, 160).state;
      for (let step = 0; step < 30; step++) {
        const offset = Math.floor(r() * 100);
        const date = addDays('2026-10-12', offset);
        const person = ORDER[Math.floor(r() * 4)]!;
        const pick = r();
        try {
          if (pick < 0.25) state = addMomException(state, date, null, ctx).state;
          else if (pick < 0.35) {
            const mom = state.shifts.find((s) => s.kind === 'mom');
            if (mom) state = cancelMomException(state, mom.date, null, ctx).state;
          } else if (pick < 0.6) {
            const len = Math.floor(r() * 6);
            state = createAbsence(state, { person, start: date, end: addDays(date, len), reason: null }, [], ctx).state;
          } else if (pick < 0.7) {
            const abs = state.absences.find((a) => !a.cancelled);
            if (abs) state = cancelAbsence(state, abs.id, ctx).state;
          } else if (pick < 0.78) {
            const sk = state.shifts.find((x) => x.status === 'skipped' && x.date >= ctx.today);
            state = sk && r() < 0.4 ? undoSkipDay(state, sk.date, ctx).state : skipDay(state, date, null, ctx).state;
          } else if (pick < 0.85) {
            const pending = state.comps.find((c) => c.status === 'pending');
            if (pending) {
              const opt = proposeCompensation(state, pending.id, ctx).options[0];
              if (opt) state = scheduleCompensation(state, pending.id, opt.date, ctx).state;
            }
          } else {
            state = changeAssignee(state, { date, newAssignee: person, reason: 'fuzz', createCompensation: r() < 0.5 }, ctx).state;
          }
        } catch (e) {
          if (!(e instanceof DomainError)) throw e; // los errores de negocio son válidos; los demás, no
        }
        assertInvariants(state);
        for (const s of state.shifts) {
          if (s.status === 'scheduled' && s.kind !== 'mom') expect(isAbsent(state, s.assignee, s.date), `ausente asignado ${s.date} (seed ${seed})`).toBe(false);
          if (s.kind === 'rotation') expect(s.assignee).toBe(s.original);
        }
        const gen = state.shifts.map((s) => s.generatesComp).filter(Boolean);
        expect(new Set(gen).size).toBe(gen.length);
        // mamá nunca recibe compensaciones y no hay compensaciones a sí mismo
        for (const c of state.comps) {
          expect(c.debtor).not.toBe(c.creditor);
          expect(c.debtor).not.toBe(MOM);
          expect(c.creditor).not.toBe(MOM);
        }
      }
    }
  });
});
