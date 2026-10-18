import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { readSupabaseConfig } from "./env";

const REQUEST_TIMEOUT_MS = 10_000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(input, {
    ...init,
    cache: "no-store",
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
}

let client: SupabaseClient | undefined;

/**
 * Supabase client authenticated with the secret key, which bypasses RLS.
 * Server code only. Never import this from a client component or send its config anywhere.
 */
export function getServerSupabaseClient(): SupabaseClient {
  if (!client) {
    const { url, secretKey } = readSupabaseConfig(process.env);
    client = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return client;
}
