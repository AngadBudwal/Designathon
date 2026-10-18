import { isDevAnalysisWriteEnabled, readAppBaseUrl, type ServerEnv } from "./env";
import { errorResponse } from "./http";

/** Matches the request_payload size check in the database. */
export const MAX_REQUEST_BYTES = 64 * 1024;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

function sameLoopbackServer(url: URL, appBase: URL): boolean {
  return isLoopbackUrl(url) && url.port === appBase.port && url.protocol === appBase.protocol;
}

const writesDisabled = () =>
  errorResponse(403, "forbidden", "Analysis writes are not enabled on this server.");

/**
 * Allows writes only on a local development server.
 *
 * Host and Origin are client-supplied, so this blocks browser-based cross-site and
 * DNS-rebinding requests but not a non-browser client that can reach the port.
 * Bind the dev server to 127.0.0.1 while writes are enabled.
 */
export function checkDevWriteAccess(request: Request, env: ServerEnv): Response | null {
  if (!isDevAnalysisWriteEnabled(env)) return writesDisabled();

  let appBase: URL;
  try {
    appBase = readAppBaseUrl(env);
  } catch {
    return writesDisabled();
  }
  if (!isLoopbackUrl(appBase)) return writesDisabled();

  const host = request.headers.get("host");
  if (!host) return writesDisabled();
  let addressed: URL;
  try {
    addressed = new URL(`${appBase.protocol}//${host}`);
  } catch {
    return writesDisabled();
  }
  if (addressed.host !== host.toLowerCase() || !sameLoopbackServer(addressed, appBase)) {
    return writesDisabled();
  }

  const origin = request.headers.get("origin");
  if (origin !== null && !origin.startsWith("chrome-extension://")) {
    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      return writesDisabled();
    }
    if (originUrl.origin !== origin || !sameLoopbackServer(originUrl, appBase)) {
      return writesDisabled();
    }
  }

  return null;
}

export type JsonBodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

const tooLarge = (): JsonBodyResult => ({
  ok: false,
  response: errorResponse(413, "validation_error", "The request body is too large."),
});

const invalidBody = (message: string): JsonBodyResult => ({
  ok: false,
  response: errorResponse(400, "validation_error", message),
});

/** Reads at most `limit` bytes, even when Content-Length is missing or wrong. */
export async function readJsonBody(request: Request, limit = MAX_REQUEST_BYTES): Promise<JsonBodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";")[0].trim().toLowerCase() !== "application/json") {
    return {
      ok: false,
      response: errorResponse(415, "validation_error", "Content-Type must be application/json."),
    };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return tooLarge();
  if (!request.body) return invalidBody("The request body must be JSON.");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return invalidBody("The request body must be valid JSON.");
  }
}

/**
 * Size of a value as Postgres prints jsonb (": " and ", " separators), which is what the
 * request_payload check measures.
 */
export function jsonbTextBytes(value: unknown): number {
  let separators = 0;
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      separators += Math.max(node.length - 1, 0);
      node.forEach(visit);
    } else if (node !== null && typeof node === "object") {
      const entries = Object.entries(node).filter(([, child]) => child !== undefined);
      separators += entries.length + Math.max(entries.length - 1, 0);
      entries.forEach(([, child]) => visit(child));
    }
  };
  visit(value);
  return new TextEncoder().encode(JSON.stringify(value)).byteLength + separators;
}
