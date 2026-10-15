import {
  absenceFor,
  activeAbsences,
  assertEditable,
  assertInvariants,
  assertRotationPerson,
  cloneState,
  effectivePerformer,
  getComp,
  isAbsent,
  lastDate,
  momShift,
  newId,
  requireShift,
} from './core';
import { addDays, formatShort, isIsoDate } from './dates';
import { proximityPenalty } from './fairness';
import { continuation, generateRotation } from './rotation';
import {
  Affected,
  ChangeEvent,
  Compensation,
  Ctx,
  DomainError,
  EventType,
  MOM,
  OpResult,
  PersonId,
  Shift,
  ShiftStatus,
  State,
} from './types';

const nm = (ctx: Ctx, id: PersonId) => ctx.names?.[id] ?? id;

function ev(type: EventType, summary: string, reason: string | null, date: string | null): ChangeEvent {
  return { type, summary, reason, date, affected: [] };
}

function needReason(reason: string | null | undefined, what: string): string {
  const r = (reason ?? '').trim();
  if (!r) throw new DomainError('INVALID', `${what} requiere un motivo.`);
  return r;
}

/* ------------------------------------------------------------------ */
/* Utilidades internas sobre un estado de trabajo (mutable)            */
/* ------------------------------------------------------------------ */

function settleRowOf(state: State, compId: string): Shift | undefined {
  return state.shifts.find((s) => s.settlesComp === compId);
}

/** Deshace la programación de una compensación: el turno vuelve a su dueño y la deuda queda pendiente. */
function revertSettlement(state: State, row: Shift, ctx: Ctx): void {
  if (!row.settlesComp) return;
  if (row.date < ctx.today) throw new DomainError('PAST_LOCKED', 'El turno de compensación ya pasó.');
  const comp = getComp(state, row.settlesComp);
  comp.status = 'pending';
  row.assignee = row.original;
  row.kind = 'rotation';
  row.reason = null;
  row.settlesComp = null;
  row.absenceId = null;
}

/** Cancela la compensación que generó este turno (si existe). */
function dropGeneratedComp(state: State, row: Shift, ctx: Ctx): void {
  if (!row.generatesComp) return;
  const c = getComp(state, row.generatesComp);
  if (c.status === 'done') throw new DomainError('CONFLICT', 'La compensación ya fue realizada; no se puede deshacer.');
  if (c.status === 'scheduled') {
    const sr = settleRowOf(state, c.id);
    if (sr) revertSettlement(state, sr, ctx);
  }
  c.status = 'cancelled';
  row.generatesComp = null;
}

/** Restituye un turno a su responsable original (sin compensación). */
function restoreToOwner(state: State, row: Shift, ctx: Ctx): void {
  dropGeneratedComp(state, row, ctx);
  row.assignee = row.original;
  row.kind = row.slot ? 'rotation' : 'mom';
  row.absenceId = null;
  row.reason = null;
}

/**
 * Un turno es "móvil" si es futuro (o de hoy), no está registrado y no fue fijado a mano.
 * Solo los turnos móviles se reordenan cuando hay viajes; los fijados (mamá, cambios manuales,
 * compensaciones programadas a mano) y los ya registrados se quedan donde están.
 */
function isMovable(row: Shift, ctx: Ctx): boolean {
  if (row.date < ctx.today || row.status !== 'scheduled') return false;
  if (row.kind === 'mom' || row.kind === 'manual') return false;
  if (row.generatesComp || row.settlesComp) return false;
  return true;
}

interface Pending {
  p: PersonId;
  cause: string | null;
}

/**
 * REGLA DE VIAJES ("adelantar y recuperar"):
 *  - Quien está ausente sale de la fila durante su ausencia: los siguientes se adelantan un día
 *    para ocupar sus turnos.
 *  - Al volver, hace sus turnos pendientes de inmediato (seguidos si debe más de uno).
 *  - Se pierde un turno y se recupera uno: pasado ese bloque, el patrón vuelve a coincidir
 *    exactamente con el original.
 * Es idempotente: si nadie ocupa un día en el que está ausente, no cambia nada.
 * Nunca asigna a una persona ausente; si no queda nadie disponible, cubre mamá.
 */
function reconcile(state: State, ctx: Ctx): void {
  // 1) Turnos fijados cuyo responsable quedó ausente: vuelven a su dueño para que se recalculen.
  for (const row of state.shifts) {
    if (row.date < ctx.today || row.status !== 'scheduled' || row.kind === 'mom' || isMovable(row, ctx)) continue;
    if (!isAbsent(state, row.assignee, row.date)) continue;
    if (row.settlesComp) revertSettlement(state, row, ctx);
    else if (row.kind === 'manual') restoreToOwner(state, row, ctx);
  }

  // 2) Reordenar los turnos móviles.
  const rows = state.shifts.filter((r) => isMovable(r, ctx));
  if (rows.length === 0) return;
  const queue = rows.map((r) => r.assignee);
  const deferred: Pending[] = [];
  let qi = 0;
  let lastCause: string | null = null;
  for (const row of rows) {
    const d = row.date;
    let who: PersonId | null = null;
    let fromDeferred = false;
    let cause: string | null = null;
    const di = deferred.findIndex((e) => !isAbsent(state, e.p, d));
    if (di >= 0) {
      const e = deferred.splice(di, 1)[0]!;
      who = e.p;
      fromDeferred = true;
      cause = e.cause;
    } else {
      while (qi < queue.length) {
        const p = queue[qi++]!;
        if (p === MOM || !isAbsent(state, p, d)) {
          who = p;
          break;
        }
        const c = absenceFor(state, p, d)!.id;
        deferred.push({ p, cause: c });
        lastCause = c;
      }
    }
    if (!who) {
      who = MOM; // nadie disponible: mamá cubre
      cause = lastCause;
    }
    const prev = row.assignee;
    row.assignee = who;
    if (who === row.original) {
      row.kind = 'rotation';
      row.absenceId = null;
      row.reason = null;
    } else if (who !== prev) {
      row.kind = fromDeferred ? 'compensation' : 'cover';
      row.absenceId = fromDeferred ? cause : lastCause ?? row.absenceId;
      row.reason = null;
    }
  }
}

/** Deshace los reordenamientos de una ausencia en los turnos futuros: cada uno vuelve a su responsable original. */
function revertAbsenceRows(state: State, absenceId: string, ctx: Ctx): void {
  for (const row of state.shifts) {
    if (row.date < ctx.today || row.status !== 'scheduled' || row.absenceId !== absenceId) continue;
    if (row.kind === 'cover' || row.kind === 'compensation') {
      row.assignee = row.original;
      row.kind = 'rotation';
      row.absenceId = null;
      row.reason = null;
    } else if (row.kind === 'manual' && row.assignee === MOM) {
      restoreToOwner(state, row, ctx);
    }
  }
}

function finish(state: State, event: ChangeEvent): OpResult {
  assertInvariants(state);
  return { state, event };
}

/* ------------------------------------------------------------------ */
/* Configuración inicial                                              */
/* ------------------------------------------------------------------ */

export function setupRotation(order: PersonId[], first: PersonId, ctx: Ctx, horizonDays = 730): OpResult {
  if (order.length < 2) throw new DomainError('INVALID', 'La rotación necesita al menos dos personas.');
  const shifts = generateRotation(order, ctx.today, first, horizonDays);
  const state: State = { order: [...order], shifts, absences: [], comps: [] };
  return finish(
    state,
    ev('setup', `Rotación iniciada hoy (${formatShort(ctx.today)}) con ${nm(ctx, first)}`, null, ctx.today),
  );
}

/** Reconstruye la rotación futura desde `from`. Descarta excepciones y coberturas futuras. */
export function rebuildFuture(state: State, from: string, startPerson: PersonId, reason: string | null, ctx: Ctx): OpResult {
  assertEditable(from, ctx);
  assertRotationPerson(state, startPerson);
  const why = needReason(reason, 'Reconstruir la rotación');
  const s = cloneState(state);
  const idx = s.shifts.findIndex((r) => r.date === from);
  if (idx < 0) throw new DomainError('NOT_FOUND', 'Fecha fuera del calendario.');
  if (s.shifts[idx]!.status !== 'scheduled') throw new DomainError('CONFLICT', 'Ese día ya fue registrado.');
  const end = lastDate(s);
  // Compensaciones: las que nacieron en turnos eliminados se cancelan; las saldadas en ellos vuelven a pendiente.
  for (const r of s.shifts.slice(idx)) {
    if (r.generatesComp) {
      const c = getComp(s, r.generatesComp);
      if (c.status !== 'done') c.status = 'cancelled';
    }
  }
  for (const r of s.shifts.slice(idx)) {
    if (r.settlesComp) {
      const c = getComp(s, r.settlesComp);
      if (c.status === 'scheduled') c.status = 'pending';
    }
  }
  const fresh = generateRotation(s.order, from, startPerson, s.shifts.length - idx);
  s.shifts.splice(idx, s.shifts.length - idx, ...fresh);
  if (lastDate(s) !== end) throw new DomainError('CONFLICT', 'Error interno al reconstruir.');
  reconcile(s, ctx);
  return finish(
    s,
    ev('rebuild', `Rotación reconstruida desde ${formatShort(from)}, empieza ${nm(ctx, startPerson)}`, why, from),
  );
}

/* ------------------------------------------------------------------ */
/* Excepción de mamá                                                  */
/* ------------------------------------------------------------------ */

/**
 * Mamá limpia en `date`: su turno se INSERTA ese día y todo lo posterior se desplaza un día.
 * Cada llamada desplaza exactamente una vez; varias llamadas se acumulan.
 */
export function addMomException(state: State, date: string, reason: string | null, ctx: Ctx): OpResult {
  assertEditable(date, ctx);
  const s = cloneState(state);
  const idx = s.shifts.findIndex((r) => r.date === date);
  if (idx < 0) throw new DomainError('NOT_FOUND', 'Fecha fuera del calendario.');
  const row = s.shifts[idx]!;
  if (row.kind === 'mom') throw new DomainError('DUPLICATE', 'Ese día ya es una excepción de mamá.');
  if (row.status !== 'scheduled') throw new DomainError('CONFLICT', 'Ese día ya tiene un registro de realización.');
  const displaced = row.assignee;
  for (let i = idx; i < s.shifts.length; i++) s.shifts[i]!.date = addDays(s.shifts[i]!.date, 1);
  s.shifts.splice(idx, 0, momShift(date, reason?.trim() || null));
  reconcile(s, ctx);
  return finish(
    s,
    ev(
      'mom_exception',
      `Mamá limpia el ${formatShort(date)}; ${nm(ctx, displaced)} y toda la rotación posterior se desplazan un día`,
      reason?.trim() || null,
      date,
    ),
  );
}

export function cancelMomException(state: State, date: string, reason: string | null, ctx: Ctx): OpResult {
  assertEditable(date, ctx);
  const s = cloneState(state);
  const idx = s.shifts.findIndex((r) => r.date === date);
  const row = s.shifts[idx];
  if (!row || row.kind !== 'mom') throw new DomainError('NOT_FOUND', 'Ese día no es una excepción de mamá.');
  if (row.status !== 'scheduled') throw new DomainError('CONFLICT', 'Esa excepción ya fue registrada como realizada.');
  s.shifts.splice(idx, 1);
  for (let i = idx; i < s.shifts.length; i++) s.shifts[i]!.date = addDays(s.shifts[i]!.date, -1);
  reconcile(s, ctx);
  return finish(
    s,
    ev('mom_cancelled', `Excepción de mamá del ${formatShort(date)} cancelada; la rotación posterior se adelanta un día`, reason?.trim() || null, date),
  );
}

/* ------------------------------------------------------------------ */
/* Cambio manual de responsable                                       */
/* ------------------------------------------------------------------ */

export interface ChangeAssigneeInput {
  date: string;
  newAssignee: PersonId;
  reason: string | null;
  createCompensation?: boolean;
}

export function changeAssignee(state: State, input: ChangeAssigneeInput, ctx: Ctx): OpResult {
  assertEditable(input.date, ctx);
  const why = needReason(input.reason, 'El cambio de responsable');
  const s = cloneState(state);
  const row = requireShift(s, input.date);
  const to = input.newAssignee;
  if (row.status !== 'scheduled') throw new DomainError('CONFLICT', 'Ese día ya tiene un registro de realización.');
  if (row.kind === 'mom') throw new DomainError('CONFLICT', 'Para quitar a mamá cancela la excepción.');
  if (to === row.assignee) throw new DomainError('INVALID', 'Esa persona ya es la responsable.');
  if (to !== MOM) assertRotationPerson(s, to);
  if (to !== MOM && isAbsent(s, to, row.date)) throw new DomainError('UNAVAILABLE', 'Esa persona está ausente ese día.');
  if (row.settlesComp) throw new DomainError('CONFLICT', 'Este turno salda una compensación: cancélala primero.');
  const from = row.assignee;

  if (row.generatesComp) {
    const c = getComp(s, row.generatesComp);
    if (c.status === 'scheduled' || c.status === 'done') {
      throw new DomainError('CONFLICT', 'La compensación de este turno ya está programada: cancélala primero.');
    }
    if (to === row.original) {
      restoreToOwner(s, row, ctx);
    } else if (to === MOM) {
      c.status = 'cancelled';
      row.generatesComp = null;
      row.assignee = MOM;
      row.kind = 'manual';
      row.reason = why;
      row.absenceId = null;
    } else {
      c.creditor = to;
      row.assignee = to;
      row.kind = 'manual';
      row.reason = why;
      row.absenceId = null;
    }
  } else if (to === row.original) {
    restoreToOwner(s, row, ctx);
  } else {
    row.assignee = to;
    row.kind = 'manual';
    row.reason = why;
    row.absenceId = null;
    if (input.createCompensation && to !== MOM && from !== MOM) {
      const comp: Compensation = { id: newId(), debtor: from, creditor: to, status: 'pending', note: null };
      s.comps.push(comp);
      row.generatesComp = comp.id;
    }
  }
  reconcile(s, ctx);
  return finish(
    s,
    ev('manual_change', `${formatShort(row.date)}: ${nm(ctx, from)} → ${nm(ctx, to)}`, why, row.date),
  );
}

/* ------------------------------------------------------------------ */
/* Registro de realización (solo el día de hoy)                       */
/* ------------------------------------------------------------------ */

export interface MarkInput {
  date: string;
  status: ShiftStatus;
  performedBy?: PersonId | null;
  reason?: string | null;
}

export function markShift(state: State, input: MarkInput, ctx: Ctx): OpResult {
  if (input.date !== ctx.today) {
    throw new DomainError('INVALID', 'La realización solo se registra el mismo día.');
  }
  const s = cloneState(state);
  const row = requireShift(s, input.date);
  const settle = row.settlesComp ? getComp(s, row.settlesComp) : null;

  if (input.status === 'scheduled') {
    if (row.status === 'scheduled') throw new DomainError('INVALID', 'Ese día no tiene registro que deshacer.');
    row.status = 'scheduled';
    row.performedBy = null;
    if (settle && settle.status === 'done') settle.status = 'scheduled';
    return finish(s, ev('performed', `${formatShort(row.date)}: registro deshecho`, null, row.date));
  }

  if (input.status === 'skipped') {
    row.status = 'skipped';
    row.performedBy = null;
    row.reason = row.reason ?? (input.reason?.trim() || null);
    if (settle) {
      settle.status = 'pending';
      row.settlesComp = null;
      row.kind = 'manual';
    }
    return finish(s, ev('performed', `${formatShort(row.date)}: nadie realizó la cocina`, input.reason?.trim() || null, row.date));
  }

  const performer = input.performedBy ?? row.assignee;
  if (performer !== MOM) assertRotationPerson(s, performer);
  if (performer === MOM && row.assignee !== MOM) {
    throw new DomainError('INVALID', 'Si mamá limpió, registra una "Excepción de mamá" para desplazar la rotación.');
  }
  let why: string | null = input.reason?.trim() || null;
  if (performer !== row.assignee) why = needReason(input.reason, 'Registrar a otra persona como quien realizó');
  row.status = 'done';
  row.performedBy = performer;
  if (settle) {
    if (performer === row.assignee) settle.status = 'done';
    else {
      settle.status = 'pending';
      row.settlesComp = null;
      row.kind = 'manual';
    }
  }
  if (performer !== row.assignee) row.reason = why;
  return finish(
    s,
    ev(
      'performed',
      performer === row.assignee
        ? `${formatShort(row.date)}: ${nm(ctx, performer)} realizó la cocina`
        : `${formatShort(row.date)}: asignada a ${nm(ctx, row.assignee)}, la realizó ${nm(ctx, performer)}`,
      why,
      row.date,
    ),
  );
}

/* ------------------------------------------------------------------ */
/* Viajes y ausencias                                                 */
/* ------------------------------------------------------------------ */

export interface AbsenceInput {
  person: PersonId;
  start: string;
  end: string;
  reason: string | null;
}

export interface AbsencePreview {
  /** Fechas de turnos de la persona que caen dentro de la ausencia (podrían cubrirse con mamá). */
  lost: string[];
  /** Cambios que provocaría en el calendario (turno por turno). */
  changes: Affected[];
  warnings: string[];
}

function validateAbsence(state: State, input: AbsenceInput, ctx: Ctx): void {
  if (!isIsoDate(input.start) || !isIsoDate(input.end)) throw new DomainError('INVALID', 'Fechas no válidas.');
  if (input.end < input.start) throw new DomainError('INVALID', 'El regreso no puede ser anterior a la salida.');
  if (input.end < ctx.today) throw new DomainError('PAST_LOCKED', 'No se pueden registrar ausencias que ya terminaron.');
  assertRotationPerson(state, input.person);
  const clash = activeAbsences(state).find((a) => a.person === input.person && a.start <= input.end && input.start <= a.end);
  if (clash) throw new DomainError('DUPLICATE', 'Esa persona ya tiene una ausencia registrada en esas fechas.');
}

function lostTurns(state: State, input: AbsenceInput, ctx: Ctx): string[] {
  const from = input.start > ctx.today ? input.start : ctx.today;
  return state.shifts
    .filter((r) => r.date >= from && r.date <= input.end && r.assignee === input.person && isMovable(r, ctx))
    .map((r) => r.date);
}

function applyAbsence(state: State, input: AbsenceInput, id: string, momDays: string[], ctx: Ctx): void {
  const lost = lostTurns(state, input, ctx);
  for (const d of momDays) {
    if (!lost.includes(d)) throw new DomainError('INVALID', `El ${d} no es un turno de ${nm(ctx, input.person)} dentro de la ausencia.`);
  }
  state.absences.push({ id, person: input.person, start: input.start, end: input.end, reason: input.reason?.trim() || null, cancelled: false });
  // Mamá como reemplazo directo: ese turno se queda con ella y no se adelanta a nadie.
  for (const d of momDays) {
    const row = requireShift(state, d);
    row.assignee = MOM;
    row.kind = 'manual';
    row.absenceId = id;
    row.reason = `Mamá cubre a ${nm(ctx, input.person)} (viaje)`;
  }
  reconcile(state, ctx);
}

function diffAssignees(before: State, after: State): Affected[] {
  const prev = new Map(before.shifts.map((r) => [r.date, r] as const));
  const out: Affected[] = [];
  for (const r of after.shifts) {
    const b = prev.get(r.date);
    if (b && b.assignee !== r.assignee) out.push({ date: r.date, from: b.assignee, to: r.assignee });
  }
  return out;
}

/** Calcula, sin guardar nada, qué turnos se mueven si se registra la ausencia. */
export function previewAbsence(state: State, input: AbsenceInput, momDays: string[], ctx: Ctx): AbsencePreview {
  validateAbsence(state, input, ctx);
  const work = cloneState(state);
  const lost = lostTurns(state, input, ctx);
  applyAbsence(work, input, 'preview', momDays, ctx);
  const warnings: string[] = [];
  if (work.shifts.some((r) => r.absenceId === 'preview' && r.assignee === MOM && r.kind === 'cover')) {
    warnings.push('Hay días en los que no queda nadie disponible; cubre mamá.');
  }
  return { lost, changes: diffAssignees(state, work), warnings };
}

export function createAbsence(state: State, input: AbsenceInput, momDays: string[], ctx: Ctx): OpResult {
  validateAbsence(state, input, ctx);
  const s = cloneState(state);
  const id = newId();
  const lost = lostTurns(state, input, ctx);
  applyAbsence(s, input, id, momDays, ctx);
  return finish(
    s,
    ev(
      'absence',
      `Ausencia de ${nm(ctx, input.person)} del ${formatShort(input.start)} al ${formatShort(input.end)}` +
        (lost.length
          ? `; ${lost.length} turno(s) suyo(s) en el viaje: ${momDays.length ? `${momDays.length} cubierto(s) por mamá, ` : ''}los demás se adelantan y ${nm(ctx, input.person)} los recupera al volver`
          : '; no afecta a ningún turno'),
      input.reason?.trim() || null,
      input.start,
    ),
  );
}

export function cancelAbsence(state: State, id: string, ctx: Ctx): OpResult {
  const s = cloneState(state);
  const abs = s.absences.find((a) => a.id === id);
  if (!abs) throw new DomainError('NOT_FOUND', 'Ausencia no encontrada.');
  if (abs.cancelled) throw new DomainError('CONFLICT', 'La ausencia ya estaba cancelada.');
  if (abs.end < ctx.today) throw new DomainError('PAST_LOCKED', 'La ausencia ya terminó.');
  abs.cancelled = true;
  revertAbsenceRows(s, id, ctx);
  reconcile(s, ctx);
  return finish(
    s,
    ev('absence_cancelled', `Ausencia de ${nm(ctx, abs.person)} cancelada; los turnos futuros vuelven a su responsable`, null, abs.start),
  );
}

/**
 * Mamá cubre un turno que cae en el viaje de su responsable: actúa como REEMPLAZO.
 * No se adelanta a nadie ni se desplaza nada; el patrón queda como si ese turno se hubiera cumplido.
 */
export function momCoversAbsentTurn(state: State, date: string, ctx: Ctx): OpResult {
  assertEditable(date, ctx);
  const s = cloneState(state);
  const row = requireShift(s, date);
  if (row.status !== 'scheduled' || row.kind === 'mom' || row.kind === 'manual') {
    throw new DomainError('CONFLICT', 'Ese día no se puede cambiar así.');
  }
  const owner = row.original;
  const abs = absenceFor(s, owner, date);
  if (!abs) throw new DomainError('INVALID', 'Solo aplica a un turno que cae en el viaje de su responsable.');
  revertAbsenceRows(s, abs.id, ctx);
  row.assignee = MOM;
  row.kind = 'manual';
  row.absenceId = abs.id;
  row.reason = `Mamá cubre a ${nm(ctx, owner)} (viaje)`;
  reconcile(s, ctx);
  return finish(
    s,
    ev('manual_change', `${formatShort(date)}: mamá cubre el turno de ${nm(ctx, owner)} (de viaje); el resto del patrón no se mueve`, null, date),
  );
}

/* ------------------------------------------------------------------ */
/* Compensaciones                                                     */
/* ------------------------------------------------------------------ */

export interface CompOption {
  date: string;
  /** Turno del acreedor que asumiría el deudor. */
  takesOver: PersonId;
  penalty: number;
  note: string;
}

export interface CompProposal {
  options: CompOption[];
  /** true si la mejor opción evita turnos consecutivos; si es false el administrador debe elegir entre alternativas. */
  clear: boolean;
}

function originDateOf(state: State, comp: Compensation, ctx: Ctx): string {
  return state.shifts.find((r) => r.generatesComp === comp.id)?.date ?? ctx.today;
}

function eligibleSettleRow(state: State, comp: Compensation, row: Shift, minDate: string, ctx: Ctx): boolean {
  return (
    row.date >= minDate &&
    row.date >= ctx.today &&
    row.status === 'scheduled' &&
    row.kind === 'rotation' &&
    row.assignee === comp.creditor &&
    row.original === comp.creditor &&
    !isAbsent(state, comp.debtor, row.date)
  );
}

export function proposeCompensation(state: State, compId: string, ctx: Ctx, windowDays = 120): CompProposal {
  const comp = getComp(state, compId);
  if (comp.status !== 'pending') throw new DomainError('CONFLICT', 'Esta compensación no está pendiente.');
  const minDate = (() => {
    const o = addDays(originDateOf(state, comp, ctx), 1);
    return o > ctx.today ? o : ctx.today;
  })();
  const maxDate = addDays(ctx.today, windowDays);
  const options: CompOption[] = [];
  for (const row of state.shifts) {
    if (row.date > maxDate) break;
    if (!eligibleSettleRow(state, comp, row, minDate, ctx)) continue;
    const prox = proximityPenalty(state, comp.debtor, row.date);
    options.push({
      date: row.date,
      takesOver: comp.creditor,
      penalty: prox,
      note: prox === 0 ? 'No queda pegado a otro turno suyo' : prox >= 2 ? 'Queda en días consecutivos con otro turno' : 'Queda a dos días de otro turno',
    });
  }
  options.sort((a, b) => a.penalty - b.penalty || (a.date < b.date ? -1 : 1));
  const top = options.slice(0, 8);
  // "Clara": la mejor opción no deja al deudor con dos turnos en días consecutivos.
  return { options: top, clear: top.length > 0 && top[0]!.penalty < 2 };
}

export function scheduleCompensation(state: State, compId: string, date: string, ctx: Ctx): OpResult {
  assertEditable(date, ctx);
  const s = cloneState(state);
  const comp = getComp(s, compId);
  if (comp.status !== 'pending') throw new DomainError('DUPLICATE', 'Esta compensación ya fue programada o cerrada.');
  const row = requireShift(s, date);
  const minDate = addDays(originDateOf(s, comp, ctx), 1);
  if (!eligibleSettleRow(s, comp, row, minDate, ctx)) {
    throw new DomainError('INVALID', 'Esa fecha no sirve para compensar (debe ser un turno propio del acreedor, posterior al turno cubierto y con el deudor disponible).');
  }
  row.assignee = comp.debtor;
  row.kind = 'compensation';
  row.settlesComp = comp.id;
  row.reason = null;
  comp.status = 'scheduled';
  return finish(
    s,
    ev('compensation_scheduled', `${nm(ctx, comp.debtor)} compensa a ${nm(ctx, comp.creditor)} el ${formatShort(date)}`, null, date),
  );
}

export function cancelCompensation(state: State, compId: string, reason: string | null, ctx: Ctx): OpResult {
  const why = needReason(reason, 'Cancelar la compensación');
  const s = cloneState(state);
  const comp = getComp(s, compId);
  if (comp.status === 'done') throw new DomainError('CONFLICT', 'La compensación ya se realizó.');
  if (comp.status === 'cancelled') throw new DomainError('CONFLICT', 'La compensación ya estaba cancelada.');
  const sr = settleRowOf(s, comp.id);
  if (sr) revertSettlement(s, sr, ctx);
  const origin = s.shifts.find((r) => r.generatesComp === comp.id);
  if (origin) origin.generatesComp = null;
  comp.status = 'cancelled';
  return finish(
    s,
    ev('compensation_cancelled', `Compensación de ${nm(ctx, comp.debtor)} a ${nm(ctx, comp.creditor)} cancelada`, why, origin?.date ?? null),
  );
}

/* ------------------------------------------------------------------ */
/* Mantenimiento automático                                           */
/* ------------------------------------------------------------------ */

/**
 * Amplía el calendario hasta `horizonEnd`, respeta las ausencias en las fechas nuevas y
 * da por realizadas las compensaciones cuyo turno ya pasó.
 */
export function housekeeping(state: State, ctx: Ctx, horizonEnd: string): State {
  const s = cloneState(state);
  if (s.shifts.length === 0) return s;
  if (lastDate(s) < horizonEnd) s.shifts.push(...continuation(s.shifts, s.order, horizonEnd));
  reconcile(s, ctx);
  for (const c of s.comps) {
    if (c.status !== 'scheduled') continue;
    const row = settleRowOf(s, c.id);
    if (row && row.date < ctx.today && effectivePerformer(row, ctx) === c.debtor) c.status = 'done';
  }
  assertInvariants(s);
  return s;
}
