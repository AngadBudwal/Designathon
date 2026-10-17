export {
  ComparisonOutcomeSchema,
  CONTRACT_VERSION,
  CurrencyCodeSchema,
  DepartmentSchema,
  GarmentComponentSchema,
  HttpUrlSchema,
  LIMITS,
  MoneySchema,
  ProcessingStatusSchema,
  TimestampSchema,
  VerificationStatusSchema,
} from "./common";
export type {
  ComparisonOutcome,
  Department,
  GarmentComponent,
  Money,
  ProcessingStatus,
  VerificationStatus,
} from "./common";

export {
  AnalysisRequestSchema,
  CompositionClaimSchema,
  FiberReadingSchema,
  SourceExcerptSchema,
} from "./analysis-request";
export type {
  AnalysisRequest,
  CompositionClaim,
  FiberReading,
  SourceExcerpt,
} from "./analysis-request";

export {
  AdvantageSchema,
  AnalysisCreatedResponseSchema,
  AnalysisFailureSchema,
  ComparableProductSchema,
  DisadvantageSchema,
  EvidenceSchema,
  ExplanationSchema,
  FitSchema,
  FullAnalysisResponseSchema,
  MaterialFactSchema,
  MeasurementSchema,
  PriceDifferenceSchema,
  PriceSnapshotSchema,
  ProductSummarySchema,
  UncertaintySchema,
  WarningSchema,
} from "./analysis-response";
export type {
  Advantage,
  AnalysisCreatedResponse,
  AnalysisFailure,
  ComparableProduct,
  Disadvantage,
  Evidence,
  Explanation,
  Fit,
  FullAnalysisResponse,
  MaterialFact,
  Measurement,
  PriceDifference,
  PriceSnapshot,
  ProductSummary,
  Uncertainty,
  Warning,
} from "./analysis-response";

export {
  ErrorCodeSchema,
  ErrorResponseSchema,
  FieldErrorSchema,
  zodErrorToErrorResponse,
} from "./error";
export type { ErrorCode, ErrorResponse, FieldError } from "./error";

export const FIXTURE_FILES = {
  extensionRequest: "lib/contracts/fixtures/extension-request.json",
  analysisCreated: "lib/contracts/fixtures/analysis-created.json",
  analysisPending: "lib/contracts/fixtures/analysis-pending.json",
  analysisAlternativesFound: "lib/contracts/fixtures/analysis-alternatives-found.json",
  analysisNoAlternative: "lib/contracts/fixtures/analysis-no-alternative.json",
  analysisInsufficient: "lib/contracts/fixtures/analysis-insufficient.json",
  analysisUnsupported: "lib/contracts/fixtures/analysis-unsupported.json",
  analysisFailed: "lib/contracts/fixtures/analysis-failed.json",
} as const;
