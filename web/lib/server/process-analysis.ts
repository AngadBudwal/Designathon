import type { ComparisonOutcome } from "@/lib/contracts";

import { loadCatalogFacts, loadSelectedCapture } from "./catalog";
import {
  assessSelected,
  candidateDepartments,
  findAlternatives,
  outcomeFor,
  type MatchedAlternative,
} from "./matching/matching";
import type { AnalysisStore } from "./store";

export type ProcessResult =
  | { status: "not_found" }
  | { status: "already_finished" }
  | { status: "processed"; outcome: ComparisonOutcome };

/**
 * Runs matching for a pending analysis against the stored catalog.
 *
 * Comparables and their reasons are written first; the analysis is marked completed only
 * after they are stored. A failure leaves the analysis pending, and a retry replaces any
 * comparables left by the failed attempt. Finished analyses are returned unchanged.
 */
export async function processAnalysis(
  store: AnalysisStore,
  analysisId: string,
  now: Date,
): Promise<ProcessResult> {
  const analysis = await store.getAnalysis(analysisId);
  if (!analysis) return { status: "not_found" };
  if (analysis.processing_status !== "pending") return { status: "already_finished" };

  const { facts: selected } = await loadSelectedCapture(store, analysis);
  let alternatives: MatchedAlternative[] = [];
  let outcome: ComparisonOutcome = "insufficient_information";
  if (selected) {
    const assessment = assessSelected(selected);
    if (assessment === "ready") {
      const candidates = await store.listCandidateProducts(
        candidateDepartments(selected.product.department),
        selected.product.id,
      );
      const facts = await loadCatalogFacts(store, candidates, now.toISOString());
      alternatives = findAlternatives(selected, facts, now).alternatives;
    }
    outcome = outcomeFor(assessment, alternatives.length);
  }

  await store.deleteComparables(analysisId);
  for (const alternative of alternatives) {
    await store.insertComparable({
      analysis_id: analysisId,
      product_id: alternative.facts.product.id,
      variant_id: null,
    });
  }
  await store.insertComparableReasons(
    alternatives.flatMap((alternative) =>
      alternative.reasons.map((reason) => ({
        analysis_id: analysisId,
        product_id: alternative.facts.product.id,
        ...reason,
      })),
    ),
  );

  const completed = await store.completeAnalysis(analysisId, outcome, now.toISOString());
  return completed ? { status: "processed", outcome } : { status: "already_finished" };
}
