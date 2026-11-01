/**
 * Backend local de PRUEBA: emula lo mínimo de Supabase (PostgREST + Auth) sobre PGlite,
 * ejecutando la migración REAL. Sirve para probar la interfaz sin cuenta de Supabase.
 * Uso:  npx tsx tests/e2e/local-backend.ts   (puerto 54321)
 */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
export const ANON_KEY = jwt({ role: 'anon', iss: 'local' });
const ADMIN_TOKEN = jwt({ role: 'authenticated', sub: ADMIN, exp: 4102444800, iss: 'local' });

export async function startBackend(port = 54321) {
  // PostgREST devuelve las fechas como 'YYYY-MM-DD'; PGlite las devolvería como Date: se desactiva esa conversión.
  const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: (v: string) => v } });
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  for (const f of readdirSync(new URL('../../supabase/migrations/', import.meta.url)).sort()) await db.exec(readFileSync(new URL(`../../supabase/migrations/${f}`, import.meta.url), 'utf8'));
  await db.exec(`insert into auth.users values ('${ADMIN}','admin@familia.test'); insert into public.admins (user_id) values ('${ADMIN}')`);
  const token = (await db.query<{ share_token: string }>('select share_token from public.app_settings')).rows[0]!.share_token;

  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>) => (queue = queue.then(fn, fn)) as Promise<T>;

  const server = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      void serial(async () => {
        const url = new URL(req.url!, 'http://x');
        const send = (code: number, body: unknown, extra: Record<string, string> = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...cors, ...extra }); res.end(JSON.stringify(body)); };
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || 'null') : null;
        if (url.pathname === '/auth/v1/token') {
          if (body?.email === 'admin@familia.test' && body?.password === 'secreto-123') {
            return send(200, { access_token: ADMIN_TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: 4102444800, refresh_token: 'r', user: { id: ADMIN, aud: 'authenticated', email: 'admin@familia.test', app_metadata: {}, user_metadata: {}, created_at: '2020-01-01' } });
          }
          return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        }
        if (url.pathname === '/auth/v1/logout') { res.writeHead(204, cors); return res.end(); }
        const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
        let role = 'anon', uid = '';
        try { const p = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString()); if (p.role === 'authenticated') { role = 'authenticated'; uid = p.sub; } } catch { /* anon */ }
        await db.exec(`select set_config('app.uid','${uid}',false)`);
        await db.exec(`set role ${role}`);
        try {
          if (url.pathname.startsWith('/rest/v1/rpc/')) {
            const fn = url.pathname.split('/').pop()!;
            const args = body ?? {};
            const keys = Object.keys(args);
            const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ')}) as r`;
            const r = await db.query<{ r: unknown }>(sql, keys.map((k) => (typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
            return send(200, r.rows[0]!.r);
          }
          if (url.pathname.startsWith('/rest/v1/')) {
            const table = url.pathname.split('/').pop()!;
            const order = url.searchParams.get('order');
            const [col, dir] = order ? order.split('.') : [];
            const range = /(\d+)-(\d+)/.exec(String(req.headers.range ?? ''));
            const lim = url.searchParams.get('limit');
            const off = range ? Number(range[1]) : 0;
            const n = range ? Number(range[2]) - off + 1 : lim ? Number(lim) : 1000;
            const r = await db.query(`select * from public.${table}${col ? ` order by ${col} ${dir === 'desc' ? 'desc' : 'asc'}` : ''} limit ${n} offset ${off}`);
            if (String(req.headers.accept).includes('vnd.pgrst.object')) return r.rows[0] ? send(200, r.rows[0]) : send(406, { message: 'no rows' });
            return send(200, r.rows);
          }
          return send(404, { message: 'not found' });
        } catch (e) {
          return send(400, { message: String((e as Error).message) });
        } finally { await db.exec('reset role'); }
      });
    });
  });
  await new Promise<void>((r) => server.listen(port, r));
  return { db, token, url: `http://localhost:${port}`, anonKey: ANON_KEY, close: () => server.close() };
}

if (process.argv[1]?.endsWith('local-backend.ts')) {
  startBackend().then((b) => {
    console.log(`Backend local en ${b.url}\nVITE_SUPABASE_URL=${b.url}\nVITE_SUPABASE_ANON_KEY=${b.anonKey}\nToken visitante: ${b.token}\nAdmin: admin@familia.test / secreto-123`);
  });
}
