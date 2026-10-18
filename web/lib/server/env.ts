export type ServerEnv = Readonly<Record<string, string | undefined>>;

/** Names the missing variable. Never includes its value. */
export class ServerConfigError extends Error {
  constructor(readonly variable: string) {
    super(`Missing or invalid server configuration: ${variable}`);
    this.name = "ServerConfigError";
  }
}

export type SupabaseConfig = { url: string; secretKey: string };

function readHttpUrl(env: ServerEnv, name: string): URL {
  const raw = env[name]?.trim();
  if (!raw) throw new ServerConfigError(name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServerConfigError(name);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ServerConfigError(name);
  return url;
}

export function readSupabaseConfig(env: ServerEnv): SupabaseConfig {
  const url = readHttpUrl(env, "SUPABASE_URL");
  const secretKey = env.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey) throw new ServerConfigError("SUPABASE_SECRET_KEY");
  return { url: url.origin, secretKey };
}

/** Website origin used to build analysis page links, such as http://localhost:3000. */
export function readAppBaseUrl(env: ServerEnv): URL {
  return new URL(readHttpUrl(env, "APP_BASE_URL").origin);
}

/** Writes are a local-development feature until authentication and rate limiting exist. */
export function isDevAnalysisWriteEnabled(env: ServerEnv): boolean {
  return env.NODE_ENV !== "production" && env.ENABLE_DEV_ANALYSIS_WRITE === "true";
}
