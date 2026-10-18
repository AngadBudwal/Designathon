import { AnalysisRequestSchema, type AnalysisRequest } from "@/lib/contracts";
import extensionRequest from "@/lib/contracts/fixtures/extension-request.json";

/** The synthetic extension fixture, parsed so tests can edit a typed copy. */
export function requestFixture(overrides: Partial<AnalysisRequest> = {}): AnalysisRequest {
  return { ...structuredClone(AnalysisRequestSchema.parse(extensionRequest.data)), ...overrides };
}

export const DEV_ENV = {
  NODE_ENV: "development",
  ENABLE_DEV_ANALYSIS_WRITE: "true",
  APP_BASE_URL: "http://localhost:3000",
  SUPABASE_URL: "https://test-project.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_TEST_ONLY_not_a_real_key",
} as const;

export function postRequest(
  body: unknown,
  headers: Record<string, string> = {},
  url = "http://localhost:3000/api/analyses",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
