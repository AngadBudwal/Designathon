import { z } from "zod";

import {
  AnalysisCreatedResponseSchema,
  AnalysisRequestSchema,
  zodErrorToErrorResponse,
} from "@/lib/contracts";

import { readAppBaseUrl, ServerConfigError, type ServerEnv } from "./env";
import { errorResponse, internalErrorResponse, jsonResponse, unavailableResponse } from "./http";
import { checkIngestionRules, ingestAnalysis, UnsupportedPageError } from "./ingest";
import { parseRetailerPage } from "./product-url";
import { readAnalysis } from "./read-analysis";
import { checkDevWriteAccess, jsonbTextBytes, MAX_REQUEST_BYTES, readJsonBody } from "./request-guard";
import { StoreError, type AnalysisStore } from "./store";

export type ServerLogger = (event: string, details: Record<string, string | null>) => void;

export type AnalysesDeps = {
  env: ServerEnv;
  getStore: () => AnalysisStore;
  newId: () => string;
  log: ServerLogger;
};

const AnalysisIdSchema = z.string().uuid();

/** Maps unexpected failures to generic responses. Logs only the failure kind and code. */
function failureResponse(error: unknown, event: string, log: ServerLogger): Response {
  if (error instanceof ServerConfigError) {
    log(event, { reason: "config", variable: error.variable });
    return unavailableResponse();
  }
  if (error instanceof StoreError) {
    log(event, { reason: "database", kind: error.kind, code: error.code });
    return error.kind === "unavailable" ? unavailableResponse() : internalErrorResponse();
  }
  if (error instanceof z.ZodError) {
    log(event, { reason: "contract", issues: String(error.issues.length) });
    return internalErrorResponse();
  }
  log(event, { reason: "unexpected", name: error instanceof Error ? error.name : typeof error });
  return internalErrorResponse();
}

const unsupportedPage = () =>
  errorResponse(422, "unsupported_page", "This page URL is not a supported retailer product page.");

/** POST /api/analyses */
export async function handleCreateAnalysis(request: Request, deps: AnalysesDeps): Promise<Response> {
  const denied = checkDevWriteAccess(request, deps.env);
  if (denied) return denied;

  const body = await readJsonBody(request, MAX_REQUEST_BYTES);
  if (!body.ok) return body.response;

  const parsed = AnalysisRequestSchema.safeParse(body.value);
  if (!parsed.success) return jsonResponse(zodErrorToErrorResponse(parsed.error), 400);
  const analysisRequest = parsed.data;

  const ruleIssues = checkIngestionRules(analysisRequest);
  if (ruleIssues.length > 0) {
    return errorResponse(400, "validation_error", "The request is invalid.", ruleIssues);
  }
  if (jsonbTextBytes(analysisRequest) > MAX_REQUEST_BYTES) {
    return errorResponse(413, "validation_error", "The request body is too large.");
  }
  if (!parseRetailerPage(analysisRequest.pageUrl)) return unsupportedPage();

  try {
    const appBase = readAppBaseUrl(deps.env);
    const result = await ingestAnalysis(deps.getStore(), analysisRequest, { newId: deps.newId });
    const created = AnalysisCreatedResponseSchema.parse({
      analysisId: result.analysisId,
      pageUrl: new URL(`/analyses/${result.analysisId}`, appBase).toString(),
      processingStatus: "pending",
      outcome: null,
    });
    return jsonResponse(created, 201);
  } catch (error) {
    if (error instanceof UnsupportedPageError) return unsupportedPage();
    return failureResponse(error, "create_analysis_failed", deps.log);
  }
}

/** GET /api/analyses/:id */
export async function handleGetAnalysis(id: string, deps: AnalysesDeps): Promise<Response> {
  const parsedId = AnalysisIdSchema.safeParse(id);
  if (!parsedId.success) {
    return errorResponse(400, "validation_error", "The analysis id is invalid.", [
      { path: "id", code: "invalid_format", message: "Expected a UUID." },
    ]);
  }

  try {
    const analysis = await readAnalysis(deps.getStore(), parsedId.data.toLowerCase());
    if (!analysis) return errorResponse(404, "not_found", "Analysis not found.");
    return jsonResponse(analysis, 200);
  } catch (error) {
    return failureResponse(error, "read_analysis_failed", deps.log);
  }
}
