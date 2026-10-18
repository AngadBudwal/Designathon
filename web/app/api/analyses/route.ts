import { handleCreateAnalysis } from "@/lib/server/analyses-handlers";
import { analysesDeps } from "@/lib/server/deps";

export async function POST(request: Request): Promise<Response> {
  return handleCreateAnalysis(request, analysesDeps());
}
