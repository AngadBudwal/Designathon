import "server-only";

import type { AnalysesDeps } from "./analyses-handlers";
import { getServerSupabaseClient } from "./supabase";
import { createSupabaseStore } from "./supabase-store";

export function analysesDeps(): AnalysesDeps {
  return {
    env: process.env,
    getStore: () => createSupabaseStore(getServerSupabaseClient()),
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
    log: (event, details) => console.error(`[api/analyses] ${event}`, details),
  };
}
