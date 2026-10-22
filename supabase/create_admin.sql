-- Paso 9 del README: convierte TU usuario en administrador.
-- 1) Crea antes tu usuario en Supabase → Authentication → Users → "Add user" (correo + contraseña, marca "Auto Confirm User").
-- 2) Cambia el correo de abajo por el tuyo y ejecuta este script en SQL Editor.
insert into public.admins (user_id)
select id from auth.users where email = 'kennethsama2002@gmail.com'
on conflict do nothing;

-- Comprobación: debe devolver 1 fila.
select u.email, a.created_at from public.admins a join auth.users u on u.id = a.user_id;
