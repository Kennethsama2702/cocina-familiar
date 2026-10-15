import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = Boolean(url && anon && !url.includes('TU-PROYECTO'));

/** Solo se usa la clave pública (anon). La seguridad real la aplican RLS y las funciones SQL. */
export const supabase: SupabaseClient | null = configured
  ? createClient(url!, anon!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;

export function client(): SupabaseClient {
  if (!supabase) throw new Error('Falta configurar VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY (ver README).');
  return supabase;
}
