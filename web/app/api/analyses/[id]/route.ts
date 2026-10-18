import { handleGetAnalysis } from "@/lib/server/analyses-handlers";
import { analysesDeps } from "@/lib/server/deps";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return handleGetAnalysis(id, analysesDeps());
}
