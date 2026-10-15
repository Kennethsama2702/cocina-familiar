import { addDays } from './dates';
import { lastSlot, rotationShift, successor } from './core';
import { DomainError, PersonId, Shift } from './types';

/** Genera `count` días consecutivos de rotación pura desde `start`, comenzando por `first`. */
export function generateRotation(order: PersonId[], start: string, first: PersonId, count: number): Shift[] {
  if (!order.includes(first)) throw new DomainError('INVALID', 'La persona inicial no pertenece a la rotación.');
  const rows: Shift[] = [];
  let p = first;
  for (let i = 0; i < count; i++) {
    rows.push(rotationShift(addDays(start, i), p));
    p = successor(order, p);
  }
  return rows;
}

/**
 * Continúa la rotación hasta `toDate` (incluida). La secuencia sigue desde el último hueco
 * de rotación existente: no se reinicia nunca (ni por mes ni por año).
 * Devuelve las filas nuevas; no toca las existentes.
 */
export function continuation(shifts: Shift[], order: PersonId[], toDate: string): Shift[] {
  const last = shifts[shifts.length - 1];
  if (!last) throw new DomainError('INVALID', 'No hay calendario que continuar.');
  const ls = lastSlot(shifts);
  if (!ls) throw new DomainError('INVALID', 'No hay ningún hueco de rotación previo.');
  const rows: Shift[] = [];
  let p = ls;
  for (let d = addDays(last.date, 1); d <= toDate; d = addDays(d, 1)) {
    p = successor(order, p);
    rows.push(rotationShift(d, p));
  }
  return rows;
}
