import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const registrarUrl = process.env.NEXT_PUBLIC_REGISTRAR_SUPABASE_URL;
const registrarKey = process.env.NEXT_PUBLIC_REGISTRAR_SUPABASE_ANON_KEY;
const mainUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const mainKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export function createRegistrarClient(): SupabaseClient {
  if (registrarUrl && registrarKey) {
    return createClient(registrarUrl, registrarKey);
  }
  if (!mainUrl || !mainKey) {
    throw new Error("Supabase is not configured for registrar lookups.");
  }
  return createClient(mainUrl, mainKey);
}

export function getRegistrarSupabase(): SupabaseClient {
  return createRegistrarClient();
}

/** Fallback client (main project) when the dedicated registrar project is unreachable. */
export function getRegistrarFallback(): SupabaseClient | null {
  if (!mainUrl || !mainKey) return null;
  if (registrarUrl && mainUrl && registrarUrl === mainUrl) return null;
  return createClient(mainUrl, mainKey);
}

/**
 * Resolve a client that is actually reachable.
 *
 * The dedicated registrar project is tried first; when it is unreachable
 * (deleted project, DNS failure, expired credentials) the main project is
 * returned instead, where the same registrar_* tables live.
 *
 * Sequential write flows (approve -> enrollment -> subjects) need one client
 * for several statements, so they use this instead of queryRegistrar(), which
 * resolves per call.
 */
export async function resolveRegistrarClient(): Promise<SupabaseClient> {
  const primary = getRegistrarSupabase();
  // No separate registrar project configured (or it points at the main one).
  if (!registrarUrl || registrarUrl === mainUrl) return primary;
  try {
    // Probe: a DNS/network failure raises, a missing table or RLS block
    // returns { error } - both mean "use the fallback".
    const { error } = await primary.from("registrar_students").select("student_id").limit(1);
    if (!error) return primary;
  } catch {
    // network / DNS failure — fall through
  }
  return getRegistrarFallback() ?? primary;
}

/**
 * Run a registrar query against the dedicated registrar project first,
 * then automatically fall back to the main project (where registrar_* tables
 * can also be installed) when the registrar project is unreachable.
 */
export async function queryRegistrar<T>(
  run: (client: SupabaseClient) => PromiseLike<{ data: T | null; error: { message: string } | null }>
): Promise<{ data: T | null; error: { message: string } | null; usedFallback: boolean }> {
  try {
    const res = await run(getRegistrarSupabase());
    if (!res.error) return { ...res, usedFallback: false };
  } catch {
    // network / DNS failure — fall through
  }
  const fallback = getRegistrarFallback();
  if (fallback) {
    try {
      const res = await run(fallback);
      return { ...res, usedFallback: true };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : "Failed to fetch" }, usedFallback: true };
    }
  }
  return { data: null, error: { message: "Registrar database is unreachable." }, usedFallback: false };
}

export const registrarSupabase = (() => {
  try {
    return createRegistrarClient();
  } catch {
    return null as unknown as SupabaseClient;
  }
})();
