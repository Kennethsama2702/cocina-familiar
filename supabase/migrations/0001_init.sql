-- =====================================================================
--  Calendario familiar de cocina · esquema, seguridad (RLS) y funciones
--  Ejecutar UNA vez en Supabase → SQL Editor (o con `supabase db push`).
--
--  Modelo de seguridad
--   · Las tablas NO son accesibles para el rol "anon" (visitantes).
--   · El administrador (usuario de Supabase Auth listado en public.admins)
--     puede LEER las tablas, pero no escribirlas directamente.
--   · TODA escritura pasa por public.apply_change(): una función transaccional
--     que comprueba que quien llama es administrador, bloquea días pasados,
--     valida invariantes y registra el historial.
--   · Los visitantes leen mediante public.get_calendar(token): solo devuelve
--     datos si el token del enlace compartido es correcto.
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Zona horaria: la fecha "de hoy" se decide SIEMPRE en el servidor.
-- ---------------------------------------------------------------------
create or replace function public.today_ec() returns date
language sql stable as $$
  select (now() at time zone 'America/Guayaquil')::date
$$;

-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------
create table public.participants (
  id          text primary key,
  name        text    not null,
  color       text    not null,
  in_rotation boolean not null,
  sort_order  int     not null
);

insert into public.participants (id, name, color, in_rotation, sort_order) values
  ('kenneth', 'Kenneth', '#4F6BED', true,  1),
  ('eric',    'Eric',    '#14A38B', true,  2),
  ('michael', 'Michael', '#E0912F', true,  3),
  ('marco',   'Marco',   '#D9566F', true,  4),
  ('mom',     'Mamá',    '#8B7FB8', false, 5);

create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.app_settings (
  id             boolean primary key default true check (id),
  rotation_start date,
  show_history   boolean not null default true,
  show_reasons   boolean not null default false,
  -- Token del enlace compartido (256 bits aleatorios). Solo lo lee el administrador.
  share_token    text    not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  -- Versión para control de concurrencia optimista entre dispositivos.
  version        bigint  not null default 0,
  updated_at     timestamptz not null default now()
);
insert into public.app_settings (id) values (true);

create table public.absences (
  id         uuid primary key,
  person_id  text not null references public.participants (id),
  start_date date not null,
  end_date   date not null,
  reason     text check (reason is null or length(reason) <= 500),
  cancelled  boolean not null default false,
  created_at timestamptz not null default now(),
  check (end_date >= start_date),
  -- Una persona no puede tener dos ausencias activas que se solapen.
  exclude using gist (person_id with =, daterange(start_date, end_date, '[]') with &&) where (not cancelled)
);

create table public.compensations (
  id          uuid primary key,
  debtor_id   text not null references public.participants (id),
  creditor_id text not null references public.participants (id),
  status      text not null check (status in ('pending', 'scheduled', 'done', 'cancelled')),
  note        text check (note is null or length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (debtor_id <> creditor_id)
);

-- Una fila por día. original_id = responsable asignado originalmente (no se sobrescribe);
-- assignee_id = responsable actual; performed_by = quien la realizó de verdad.
create table public.shifts (
  date           date primary key,
  slot_id        text references public.participants (id),
  assignee_id    text not null references public.participants (id),
  original_id    text not null references public.participants (id),
  performed_by   text references public.participants (id),
  status         text not null default 'scheduled' check (status in ('scheduled', 'done', 'skipped')),
  kind           text not null check (kind in ('rotation', 'mom', 'cover', 'manual', 'compensation')),
  reason         text check (reason is null or length(reason) <= 500),
  absence_id     uuid references public.absences (id),
  generates_comp uuid references public.compensations (id),
  settles_comp   uuid references public.compensations (id),
  updated_at     timestamptz not null default now(),
  check ((kind = 'mom') = (slot_id is null)),
  check (performed_by is null or status = 'done'),
  check (status <> 'done' or performed_by is not null),
  -- Un turno no puede generar dos compensaciones ni una compensación saldarse dos veces.
  -- (Diferidas: durante un desplazamiento los ids "viajan" de una fila a otra.)
  constraint shifts_generates_comp_uq unique (generates_comp) deferrable initially deferred,
  constraint shifts_settles_comp_uq   unique (settles_comp)   deferrable initially deferred
);

-- Registro de modificaciones: solo se añade, nunca se edita ni se borra.
create table public.change_log (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  type           text not null check (type in (
                   'setup', 'rebuild', 'mom_exception', 'mom_cancelled', 'manual_change', 'performed',
                   'absence', 'absence_cancelled', 'compensation_scheduled', 'compensation_cancelled',
                   'settings', 'share_link')),
  summary        text not null check (length(summary) <= 500),
  reason         text check (reason is null or length(reason) <= 500),
  event_date     date,
  affected       jsonb not null default '[]'::jsonb,
  affected_count int   not null default 0,
  actor          uuid
);

-- ---------------------------------------------------------------------
-- Disparadores de integridad
-- ---------------------------------------------------------------------

-- Los días pasados son inmutables para TODOS los roles (incluidos los administradores).
create or replace function public.lock_past_shifts() returns trigger
language plpgsql as $$
declare
  t date := public.today_ec();
begin
  if tg_op = 'INSERT' then
    if new.date < t then
      raise exception 'PAST_LOCKED: no se pueden crear días pasados (%)', new.date;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.date < t or new.date < t then
      raise exception 'PAST_LOCKED: no se pueden modificar días pasados (%)', old.date;
    end if;
    return new;
  else
    if old.date < t then
      raise exception 'PAST_LOCKED: no se pueden eliminar días pasados (%)', old.date;
    end if;
    return old;
  end if;
end $$;

create trigger shifts_lock_past
  before insert or update or delete on public.shifts
  for each row execute function public.lock_past_shifts();

create or replace function public.immutable_history() returns trigger
language plpgsql as $$
begin
  raise exception 'HISTORY_IMMUTABLE: el registro de cambios no se puede editar ni borrar';
end $$;

create trigger change_log_immutable
  before update or delete on public.change_log
  for each row execute function public.immutable_history();

-- Las ausencias nunca se borran (se cancelan), para conservar la trazabilidad.
create trigger absences_no_delete
  before delete on public.absences
  for each row execute function public.immutable_history();

create trigger compensations_no_delete
  before delete on public.compensations
  for each row execute function public.immutable_history();

-- ---------------------------------------------------------------------
-- Funciones auxiliares
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.server_clock() returns jsonb
language sql stable as $$
  select jsonb_build_object('now', now(), 'today', public.today_ec())
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.participants  enable row level security;
alter table public.admins        enable row level security;
alter table public.app_settings  enable row level security;
alter table public.absences      enable row level security;
alter table public.compensations enable row level security;
alter table public.shifts        enable row level security;
alter table public.change_log    enable row level security;

-- Nadie (ni anon ni authenticated) escribe directamente en las tablas.
revoke all on public.participants, public.admins, public.app_settings, public.absences,
              public.compensations, public.shifts, public.change_log
  from public, anon, authenticated;

-- El administrador solo puede LEER; el visitante (anon) no tiene acceso alguno.
grant select on public.participants, public.app_settings, public.absences,
                public.compensations, public.shifts, public.change_log, public.admins
  to authenticated;

create policy participants_admin_read  on public.participants  for select to authenticated using (public.is_admin());
create policy app_settings_admin_read  on public.app_settings  for select to authenticated using (public.is_admin());
create policy absences_admin_read      on public.absences      for select to authenticated using (public.is_admin());
create policy compensations_admin_read on public.compensations for select to authenticated using (public.is_admin());
create policy shifts_admin_read        on public.shifts        for select to authenticated using (public.is_admin());
create policy change_log_admin_read    on public.change_log    for select to authenticated using (public.is_admin());
create policy admins_read_self         on public.admins        for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- LECTURA PARA VISITANTES (enlace compartido, sin cuentas)
-- ---------------------------------------------------------------------
create or replace function public.get_calendar(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  cfg public.app_settings;
  t   date := public.today_ec();
begin
  select * into cfg from public.app_settings where id;
  if p_token is null or length(p_token) < 32 or p_token <> cfg.share_token then
    raise exception 'INVALID_LINK' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'now', now(),
    'today', t,
    'settings', jsonb_build_object(
      'show_history', cfg.show_history,
      'show_reasons', cfg.show_reasons,
      'rotation_start', cfg.rotation_start,
      'version', cfg.version),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'name', p.name, 'color', p.color,
               'in_rotation', p.in_rotation, 'sort_order', p.sort_order) order by p.sort_order), '[]'::jsonb)
        from public.participants p),
    'shifts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'date', sh.date, 'slot_id', sh.slot_id, 'assignee_id', sh.assignee_id,
               'original_id', sh.original_id, 'performed_by', sh.performed_by,
               'status', sh.status, 'kind', sh.kind,
               'reason', case when cfg.show_reasons then sh.reason else null end,
               'absence_id', sh.absence_id, 'generates_comp', sh.generates_comp,
               'settles_comp', sh.settles_comp) order by sh.date), '[]'::jsonb)
        from public.shifts sh
       where cfg.show_history or sh.date >= t),
    'absences', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', a.id, 'person_id', a.person_id, 'start_date', a.start_date, 'end_date', a.end_date,
               'reason', case when cfg.show_reasons then a.reason else null end,
               'cancelled', false) order by a.start_date), '[]'::jsonb)
        from public.absences a
       where not a.cancelled and (cfg.show_history or a.end_date >= t)),
    'compensations', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', c.id, 'debtor_id', c.debtor_id, 'creditor_id', c.creditor_id,
               'status', c.status, 'note', null) order by c.created_at), '[]'::jsonb)
        from public.compensations c
       where c.status <> 'cancelled'),
    'changes', case when cfg.show_history then (
      select coalesce(jsonb_agg(x order by x.id desc), '[]'::jsonb) from (
        select l.id, l.created_at, l.type, l.summary,
               case when cfg.show_reasons then l.reason else null end as reason,
               l.event_date, l.affected_count
          from public.change_log l
         order by l.id desc limit 200) x)
      else '[]'::jsonb end
  );
end $$;

-- ---------------------------------------------------------------------
-- ESCRITURA: única puerta de entrada, solo administradores
-- ---------------------------------------------------------------------
-- p_payload = {
--   expected_version: bigint,
--   settings:     { rotation_start?, show_history?, show_reasons? },
--   absences:     [ {id, person_id, start_date, end_date, reason, cancelled} ],
--   compensations:[ {id, debtor_id, creditor_id, status, note} ],
--   delete_dates: [ 'YYYY-MM-DD' ],
--   shifts:       [ {date, slot_id, assignee_id, original_id, performed_by, status, kind,
--                    reason, absence_id, generates_comp, settles_comp} ],
--   event:        { type, summary, reason, date, affected, affected_count }
-- }
create or replace function public.apply_change(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_today   date := public.today_ec();
  v_version bigint;
  r         jsonb;
  v_event   jsonb := p_payload -> 'event';
  v_prev    public.absences;
  v_comp    public.compensations;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: solo el administrador puede modificar el calendario' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID: carga útil no válida';
  end if;
  if octet_length(p_payload::text) > 3000000 then
    raise exception 'INVALID: carga útil demasiado grande';
  end if;

  -- Una sola modificación a la vez + control de versión (evita pisar cambios de otro dispositivo).
  perform pg_advisory_xact_lock(727001);
  select version into v_version from public.app_settings where id;
  if (p_payload ->> 'expected_version')::bigint is distinct from v_version then
    raise exception 'STALE_VERSION: el calendario cambió desde que lo cargaste; recarga e inténtalo de nuevo';
  end if;

  -- Configuración (lista blanca de campos)
  if jsonb_typeof(p_payload -> 'settings') = 'object' then
    update public.app_settings set
      rotation_start = coalesce((p_payload -> 'settings' ->> 'rotation_start')::date, rotation_start),
      show_history   = coalesce((p_payload -> 'settings' ->> 'show_history')::boolean, show_history),
      show_reasons   = coalesce((p_payload -> 'settings' ->> 'show_reasons')::boolean, show_reasons)
    where id;
  end if;

  -- Ausencias (no se borran; se cancelan). Solo las que no han terminado.
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'absences', '[]'::jsonb)) loop
    select * into v_prev from public.absences where id = (r ->> 'id')::uuid;
    if found then
      if v_prev.end_date < v_today then
        raise exception 'PAST_LOCKED: la ausencia ya terminó';
      end if;
      update public.absences set cancelled = coalesce((r ->> 'cancelled')::boolean, cancelled)
       where id = v_prev.id;
    else
      if (r ->> 'end_date')::date < v_today then
        raise exception 'PAST_LOCKED: no se pueden registrar ausencias que ya terminaron';
      end if;
      if not exists (select 1 from public.participants where id = r ->> 'person_id' and in_rotation) then
        raise exception 'INVALID: la persona no pertenece a la rotación';
      end if;
      insert into public.absences (id, person_id, start_date, end_date, reason, cancelled)
      values ((r ->> 'id')::uuid, r ->> 'person_id', (r ->> 'start_date')::date, (r ->> 'end_date')::date,
              nullif(r ->> 'reason', ''), coalesce((r ->> 'cancelled')::boolean, false));
    end if;
  end loop;

  -- Compensaciones (una cancelada no se reabre)
  for r in select * from jsonb_array_elements(coalesce(p_payload -> 'compensations', '[]'::jsonb)) loop
    select * into v_comp from public.compensations where id = (r ->> 'id')::uuid;
    if found then
      if v_comp.status = 'cancelled' and (r ->> 'status') <> 'cancelled' then
        raise exception 'CONFLICT: una compensación cancelada no se puede reabrir';
      end if;
      update public.compensations set
        creditor_id = r ->> 'creditor_id',
        status      = r ->> 'status',
        note        = nullif(r ->> 'note', ''),
        updated_at  = now()
      where id = v_comp.id;
    else
      insert into public.compensations (id, debtor_id, creditor_id, status, note)
      values ((r ->> 'id')::uuid, r ->> 'debtor_id', r ->> 'creditor_id', r ->> 'status', nullif(r ->> 'note', ''));
    end if;
  end loop;

  -- Turnos: eliminar y luego insertar/actualizar (el disparador bloquea cualquier día pasado)
  delete from public.shifts
   where date in (select d::date from jsonb_array_elements_text(coalesce(p_payload -> 'delete_dates', '[]'::jsonb)) d);

  insert into public.shifts (date, slot_id, assignee_id, original_id, performed_by, status, kind, reason,
                             absence_id, generates_comp, settles_comp, updated_at)
  select x.date, x.slot_id, x.assignee_id, x.original_id, x.performed_by, x.status, x.kind, nullif(x.reason, ''),
         x.absence_id, x.generates_comp, x.settles_comp, now()
    from jsonb_to_recordset(coalesce(p_payload -> 'shifts', '[]'::jsonb)) as x(
           date date, slot_id text, assignee_id text, original_id text, performed_by text, status text,
           kind text, reason text, absence_id uuid, generates_comp uuid, settles_comp uuid)
  on conflict (date) do update set
    slot_id = excluded.slot_id, assignee_id = excluded.assignee_id, original_id = excluded.original_id,
    performed_by = excluded.performed_by, status = excluded.status, kind = excluded.kind,
    reason = excluded.reason, absence_id = excluded.absence_id,
    generates_comp = excluded.generates_comp, settles_comp = excluded.settles_comp, updated_at = now();

  -- Invariante 1: calendario continuo, sin huecos
  if exists (select 1 from public.shifts)
     and (select count(*) from public.shifts) <> (select max(date) - min(date) + 1 from public.shifts) then
    raise exception 'CALENDAR_GAP: el calendario quedaría con huecos';
  end if;

  -- Invariante 2: nadie ausente tiene una tarea pendiente asignada
  if exists (
    select 1
      from public.shifts s
      join public.absences a
        on a.person_id = s.assignee_id and not a.cancelled and s.date between a.start_date and a.end_date
     where s.date >= v_today and s.status = 'scheduled' and s.kind <> 'mom') then
    raise exception 'ABSENT_ASSIGNED: se asignaría una tarea a una persona ausente';
  end if;

  -- Historial (solo se añade)
  if jsonb_typeof(v_event) = 'object' then
    insert into public.change_log (type, summary, reason, event_date, affected, affected_count, actor)
    values (v_event ->> 'type', left(v_event ->> 'summary', 500), left(nullif(v_event ->> 'reason', ''), 500),
            nullif(v_event ->> 'date', '')::date, coalesce(v_event -> 'affected', '[]'::jsonb),
            coalesce((v_event ->> 'affected_count')::int, 0), auth.uid());
  end if;

  update public.app_settings set version = version + 1, updated_at = now() where id
  returning version into v_version;

  return jsonb_build_object('version', v_version);
end $$;

-- Regenerar el enlace compartido invalida el anterior.
create or replace function public.rotate_share_token() returns text
language plpgsql security definer set search_path = public as $$
declare
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN: solo el administrador puede regenerar el enlace' using errcode = '42501';
  end if;
  update public.app_settings set share_token = v_token, updated_at = now() where id;
  insert into public.change_log (type, summary, actor) values ('share_link', 'Enlace compartido regenerado', auth.uid());
  return v_token;
end $$;

-- ---------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------
revoke all on function public.apply_change(jsonb)  from public, anon, authenticated;
revoke all on function public.rotate_share_token() from public, anon, authenticated;
revoke all on function public.is_admin()            from public, anon, authenticated;
revoke all on function public.get_calendar(text)    from public, anon, authenticated;
revoke all on function public.server_clock()        from public, anon, authenticated;

grant execute on function public.apply_change(jsonb)  to authenticated;
grant execute on function public.rotate_share_token() to authenticated;
grant execute on function public.is_admin()            to authenticated;
grant execute on function public.get_calendar(text)    to anon, authenticated;
grant execute on function public.server_clock()        to anon, authenticated;
