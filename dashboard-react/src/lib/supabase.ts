import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client using the PUBLISHABLE (anon) key.
//
// This replaces the old server-side client that used SUPABASE_SERVICE_ROLE_KEY.
// The service-role key must never reach the browser. Read access for the anon
// role is governed by the row-level-security policies in
// `supabase-rls.DRAFT.sql` (apply that migration before the dashboard will
// return any data).

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function isSupabaseConfigured() {
  return Boolean(url && anonKey);
}

export function getSupabaseClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
