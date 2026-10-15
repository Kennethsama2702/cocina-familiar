import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { addDays, dateInEcuador, setupRotation, addMomException, buildPlan, createAbsence, State, Shift } from '../../src/domain';

/**
 * Pruebas de seguridad contra un PostgreSQL real (PGlite) con la migración REAL.
 * Se simula Supabase: roles anon/authenticated, auth.uid() y auth.users.
 */
const ADMIN = '11111111-1111-1111-1111-111111111111';
const STRANGER = '22222222-2222-2222-2222-222222222222';
const ORDER = ['kenneth', 'eric', 'michael', 'marco'];

let db: PGlite;
let TODAY: string;
let token: string;

async function as(role: 'anon' | 'authenticated' | 'postgres', uid: string | null, fn: () => Promise<void>) {
  await db.exec(`select set_config('app.uid', '${uid ?? ''}', false)`);
  await db.exec(`set role ${role}`);
  try { await fn(); } finally { await db.exec('reset role'); }
}
async function fails(role: 'anon' | 'authenticated', uid: string | null, sql: string, params: unknown[] = []): Promise<string> {
  let msg = '';
  await as(role, uid, async () => {
    try { await db.query(sql, params); } catch (e) { msg = String((e as Error).message); }
  });
  return msg;
}

const rowOf = (s: Shift) => ({
  date: s.date, slot_id: s.slot, assignee_id: s.assignee, original_id: s.original, performed_by: s.performedBy,
  status: s.status, kind: s.kind, reason: s.reason, absence_id: s.absenceId, generates_comp: s.generatesComp, settles_comp: s.settlesComp,
});
function payload(version: number, plan: ReturnType<typeof buildPlan>) {
  return {
    expected_version: version,
    shifts: plan.shifts.map(rowOf),
    delete_dates: plan.deleteDates,
    absences: plan.absences.map((a) => ({ id: a.id, person_id: a.person, start_date: a.start, end_date: a.end, reason: a.reason, cancelled: a.cancelled })),
    compensations: plan.comps.map((c) => ({ id: c.id, debtor_id: c.debtor, creditor_id: c.creditor, status: c.status, note: c.note })),
    event: plan.event && { type: plan.event.type, summary: plan.event.summary, reason: plan.event.reason, date: plan.event.date, affected: plan.event.affected, affected_count: plan.event.affectedCount },
  };
}
async function version(): Promise<number> {
  const r = await db.query<{ version: string }>('select version from public.app_settings');
  return Number(r.rows[0]!.version);
}
async function loadShifts(): Promise<Shift[]> {
  const r = await db.query<any>('select * from public.shifts order by date');
  return r.rows.map((x) => ({
    date: x.date instanceof Date ? x.date.toISOString().slice(0, 10) : x.date, slot: x.slot_id, assignee: x.assignee_id, original: x.original_id,
    performedBy: x.performed_by, status: x.status, kind: x.kind, reason: x.reason, absenceId: x.absence_id,
    generatesComp: x.generates_comp, settlesComp: x.settles_comp,
  }));
}
const stateOf = (shifts: Shift[]): State => ({ order: ORDER, shifts, absences: [], comps: [] });
const call = (p: unknown) => db.query('select public.apply_change($1::jsonb) as r', [JSON.stringify(p)]);

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  await db.exec(readFileSync('supabase/migrations/0001_init.sql', 'utf8'));
  await db.exec(`insert into auth.users values ('${ADMIN}', 'admin@x.com'), ('${STRANGER}', 'otro@x.com');
                 insert into public.admins (user_id) values ('${ADMIN}')`);
  TODAY = dateInEcuador(new Date());
  token = (await db.query<{ share_token: string }>('select share_token from public.app_settings')).rows[0]!.share_token;
  // Siembra: 60 días de rotación desde hoy, escritos por el administrador a través de apply_change.
  const st = setupRotation(ORDER, 'kenneth', { today: TODAY }, 60);
  const plan = buildPlan({ order: ORDER, shifts: [], absences: [], comps: [] }, st.state, st.event, { today: TODAY });
  await as('authenticated', ADMIN, async () => { await call(payload(0, plan)); });
});

describe('visitantes (anon)', () => {
  it('no pueden leer ninguna tabla directamente', async () => {
    for (const t of ['shifts', 'participants', 'absences', 'compensations', 'change_log', 'app_settings', 'admins']) {
      expect(await fails('anon', null, `select * from public.${t}`), t).toMatch(/permission denied/i);
    }
  });
  it('no pueden escribir (insert/update/delete) en ninguna tabla', async () => {
    const t = TODAY;
    expect(await fails('anon', null, `insert into public.shifts (date, assignee_id, original_id, kind, slot_id) values ('${addDays(t, 900)}','eric','eric','rotation','eric')`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `update public.shifts set assignee_id='eric'`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `delete from public.shifts`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `update public.app_settings set share_token='x'`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `insert into public.admins (user_id) values ('${STRANGER}')`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `delete from public.change_log`)).toMatch(/permission denied/i);
  });
  it('no pueden llamar a apply_change ni regenerar el enlace', async () => {
    expect(await fails('anon', null, `select public.apply_change('{}'::jsonb)`)).toMatch(/permission denied/i);
    expect(await fails('anon', null, `select public.rotate_share_token()`)).toMatch(/permission denied/i);
  });
  it('con token incorrecto o ausente no obtienen datos', async () => {
    expect(await fails('anon', null, `select public.get_calendar('abc')`)).toMatch(/INVALID_LINK/);
    expect(await fails('anon', null, `select public.get_calendar(null)`)).toMatch(/INVALID_LINK/);
    expect(await fails('anon', null, `select public.get_calendar($1)`, ['x'.repeat(64)])).toMatch(/INVALID_LINK/);
  });
  it('con el token correcto leen el calendario, sin el token ni motivos privados', async () => {
    await as('anon', null, async () => {
      const r = await db.query<{ c: any }>('select public.get_calendar($1) as c', [token]);
      const c = r.rows[0]!.c;
      expect(c.shifts.length).toBe(60);
      expect(c.today).toBe(TODAY);
      expect(JSON.stringify(c)).not.toContain(token);
      expect(c.settings.share_token).toBeUndefined();
      expect(Object.keys(c)).not.toContain('admins');
    });
  });
});

describe('usuarios autenticados que NO son administradores', () => {
  it('no ven datos ni pueden escribir', async () => {
    await as('authenticated', STRANGER, async () => {
      const r = await db.query('select * from public.shifts');
      expect(r.rows).toHaveLength(0); // RLS filtra todo
      expect((await db.query('select * from public.app_settings')).rows).toHaveLength(0); // el token no se filtra
    });
    expect(await fails('authenticated', STRANGER, `update public.shifts set assignee_id='eric'`)).toMatch(/permission denied/i);
    expect(await fails('authenticated', STRANGER, `insert into public.admins (user_id) values ('${STRANGER}')`)).toMatch(/permission denied/i);
    expect(await fails('authenticated', STRANGER, `select public.apply_change('{"expected_version":0}'::jsonb)`)).toMatch(/FORBIDDEN/);
    expect(await fails('authenticated', STRANGER, `select public.rotate_share_token()`)).toMatch(/FORBIDDEN/);
  });
});

describe('administrador', () => {
  it('puede leer las tablas pero no escribir directamente en ellas', async () => {
    await as('authenticated', ADMIN, async () => {
      expect((await db.query('select * from public.shifts')).rows.length).toBe(60);
      expect((await db.query('select share_token from public.app_settings')).rows[0]).toBeTruthy();
    });
    expect(await fails('authenticated', ADMIN, `update public.shifts set assignee_id='eric'`)).toMatch(/permission denied/i);
    expect(await fails('authenticated', ADMIN, `delete from public.change_log`)).toMatch(/permission denied/i);
  });

  it('puede registrar una excepción de mamá mediante apply_change (todo el desplazamiento, atómico)', async () => {
    const shifts = await loadShifts();
    const before = stateOf(shifts);
    const d = addDays(TODAY, 2);
    const r = addMomException(before, d, 'Visita', { today: TODAY });
    const plan = buildPlan(before, r.state, r.event, { today: TODAY });
    await as('authenticated', ADMIN, async () => { await call(payload(await version(), plan)); });
    const after = await loadShifts();
    expect(after.find((s) => s.date === d)!.assignee).toBe('mom');
    expect(after).toHaveLength(61);
    expect(after.map((s) => s.assignee)).toEqual(r.state.shifts.map((s) => s.assignee));
    const log = await db.query<any>('select * from public.change_log where type = $1', ['mom_exception']);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].actor).toBe(ADMIN);
  });

  it('puede registrar un viaje (los siguientes se adelantan)', async () => {
    const before = stateOf(await loadShifts());
    const r = createAbsence(before, { person: 'michael', start: addDays(TODAY, 5), end: addDays(TODAY, 12), reason: 'Viaje' }, [], { today: TODAY });
    const plan = buildPlan(before, r.state, r.event, { today: TODAY });
    await as('authenticated', ADMIN, async () => { await call(payload(await version(), plan)); });
    expect((await db.query('select * from public.absences')).rows).toHaveLength(1);
    expect((await loadShifts()).map((x) => [x.date, x.assignee, x.kind])).toEqual(r.state.shifts.map((x) => [x.date, x.assignee, x.kind]));
  });

  it('un cambio que falla a mitad se revierte por completo (atomicidad)', async () => {
    const shifts = await loadShifts();
    const v = await version();
    const snapshot = JSON.stringify(shifts);
    const bad = payload(v, { shifts: [{ ...shifts[10]!, assignee: 'eric' }, { ...shifts[11]!, assignee: 'nadie' }], deleteDates: [], absences: [], comps: [], event: null });
    await as('authenticated', ADMIN, async () => {
      await expect(call(bad)).rejects.toThrow();
    });
    expect(JSON.stringify(await loadShifts())).toBe(snapshot);
    expect(await version()).toBe(v);
  });

  it('detecta cambios obsoletos (otro dispositivo modificó antes)', async () => {
    const v = await version();
    await as('authenticated', ADMIN, async () => {
      await expect(call({ expected_version: v - 1 })).rejects.toThrow(/STALE_VERSION/);
    });
  });

  it('rechaza dejar huecos en el calendario', async () => {
    const v = await version();
    const target = addDays(TODAY, 20);
    await as('authenticated', ADMIN, async () => {
      await expect(call({ expected_version: v, delete_dates: [target] })).rejects.toThrow(/CALENDAR_GAP/);
    });
  });

  it('rechaza asignar una tarea a alguien ausente', async () => {
    const v = await version();
    const sh = (await loadShifts()).find((s) => s.date === addDays(TODAY, 30))!;
    // Eric ausente el día 30 y se intenta asignarle ese día
    const abs = { id: '33333333-3333-3333-3333-333333333333', person_id: 'eric', start_date: sh.date, end_date: sh.date, reason: null, cancelled: false };
    await as('authenticated', ADMIN, async () => {
      await expect(call({ expected_version: v, absences: [abs], shifts: [{ ...rowOf(sh), assignee_id: 'eric', kind: 'manual' }] })).rejects.toThrow(/ABSENT_ASSIGNED/);
    });
  });

  it('el historial no se puede editar ni borrar ni siquiera con permisos de dueño', async () => {
    await expect(db.exec('update public.change_log set summary = \'x\'')).rejects.toThrow(/HISTORY_IMMUTABLE/);
    await expect(db.exec('delete from public.change_log')).rejects.toThrow(/HISTORY_IMMUTABLE/);
    await expect(db.exec('delete from public.absences')).rejects.toThrow(/HISTORY_IMMUTABLE/);
  });

  it('el enlace regenerado invalida el anterior', async () => {
    let fresh = '';
    await as('authenticated', ADMIN, async () => {
      fresh = (await db.query<{ t: string }>('select public.rotate_share_token() as t')).rows[0]!.t;
    });
    expect(fresh).not.toBe(token);
    expect(await fails('anon', null, `select public.get_calendar($1)`, [token])).toMatch(/INVALID_LINK/);
    await as('anon', null, async () => { await db.query('select public.get_calendar($1)', [fresh]); });
    token = fresh;
  });
});

describe('días pasados (bloqueo en la base de datos)', () => {
  // Se construye un pasado simulado: se desactiva el disparador SOLO para sembrar datos de prueba.
  const seedPast = async () => {
    await db.exec('alter table public.shifts disable trigger shifts_lock_past');
    await db.exec(`insert into public.shifts (date, slot_id, assignee_id, original_id, kind) values
      ('${addDays(TODAY, -2)}','kenneth','kenneth','kenneth','rotation'), ('${addDays(TODAY, -1)}','eric','eric','eric','rotation')`);
    await db.exec('alter table public.shifts enable trigger shifts_lock_past');
  };

  it('ni siquiera un administrador puede modificar, borrar o crear días pasados', async () => {
    await seedPast();
    const v = await version();
    const yesterday = addDays(TODAY, -1);
    const row = { date: yesterday, slot_id: 'eric', assignee_id: 'michael', original_id: 'eric', performed_by: null, status: 'scheduled', kind: 'manual', reason: 'x', absence_id: null, generates_comp: null, settles_comp: null };
    await as('authenticated', ADMIN, async () => {
      await expect(call({ expected_version: v, shifts: [row] })).rejects.toThrow(/PAST_LOCKED/);
      await expect(call({ expected_version: v, delete_dates: [yesterday] })).rejects.toThrow(/PAST_LOCKED/);
      await expect(call({ expected_version: v, shifts: [{ ...row, date: addDays(TODAY, -30) }] })).rejects.toThrow(/PAST_LOCKED/);
      await expect(call({ expected_version: v, absences: [{ id: '44444444-4444-4444-4444-444444444444', person_id: 'eric', start_date: addDays(TODAY, -5), end_date: yesterday, reason: null, cancelled: false }] })).rejects.toThrow(/PAST_LOCKED/);
    });
    // intento directo como dueño de la base: también bloqueado por el disparador
    await expect(db.exec(`update public.shifts set assignee_id='michael' where date='${yesterday}'`)).rejects.toThrow(/PAST_LOCKED/);
    await expect(db.exec(`delete from public.shifts where date='${yesterday}'`)).rejects.toThrow(/PAST_LOCKED/);
  });

  it('un cambio que arrastraría un día pasado (p. ej. mamá "ayer") se rechaza', async () => {
    const v = await version();
    const rows = await loadShifts();
    const yesterday = rows.find((s) => s.date === addDays(TODAY, -1))!;
    await as('authenticated', ADMIN, async () => {
      await expect(call({ expected_version: v, shifts: [{ ...rowOf(yesterday), kind: 'mom', slot_id: null, assignee_id: 'mom' }] })).rejects.toThrow(/PAST_LOCKED/);
    });
  });

  it('hoy sí es editable', async () => {
    const v = await version();
    const today = (await loadShifts()).find((s) => s.date === TODAY)!;
    const other = today.assignee === 'eric' ? 'marco' : 'eric';
    await as('authenticated', ADMIN, async () => {
      await call({ expected_version: v, shifts: [{ ...rowOf(today), assignee_id: other, kind: 'manual', reason: 'prueba' }] });
    });
    expect((await loadShifts()).find((s) => s.date === TODAY)!.assignee).toBe(other);
  });
});
