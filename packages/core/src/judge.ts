import type { Chunk, Config, ResultRef } from "./types.js";

export interface TaskState {
  recent_user_messages: string[];
  latest_assistant_text: string;
  working_files: string[];
}

export interface JevRequest {
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
  model: string;
}

export interface JevClient {
  systemOne(
    request: JevRequest,
    signal?: AbortSignal,
  ): Promise<{ answers: Record<string, { noul: number }> }>;
}

function instructionsFor(index: number): string {
  return (
    `Given the agent's current task, will it need to look at the text of \`chunks[${index}]\` ` +
    "again to finish, for example because it contains code it will change or call, an error " +
    "it is still fixing, or a value it must reuse?"
  );
}

export function buildRequest(
  result: ResultRef,
  chunks: Chunk[],
  task: TaskState,
  afterResult: string,
  config: Config,
): JevRequest {
  const questions: Record<string, unknown> = {};
  for (const chunk of chunks) {
    questions[`chunk::${chunk.index}`] = {
      type: "noul",
      instructions: instructionsFor(chunk.index),
      criteria: {
        true: "Still needed for work that remains",
        false: "Background already used, or unrelated to what remains",
      },
    };
  }
  return {
    model: config.jevModel,
    state: {
      task,
      result: { tool: result.toolName, input: result.input },
      after_result: afterResult,
      chunks: chunks.map((chunk) => ({ lines: `${chunk.startLine}-${chunk.endLine}`, text: chunk.text })),
    },
    questions,
  };
}

export async function judgeResult(
  client: JevClient,
  request: JevRequest,
  chunkCount: number,
  config: Config,
  signal?: AbortSignal,
): Promise<number[] | null> {
  if (signal?.aborted) return null;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A client that ignores its signal would otherwise hang the sweep, so the
  // budget is a race, not just an abort.
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, config.jevBudgetMs);
  });

  try {
    const response = await Promise.race([client.systemOne(request, controller.signal), budget]);
    if (response === null) return null;
    const probabilities: number[] = [];
    for (let index = 0; index < chunkCount; index++) {
      const answer = response.answers[`chunk::${index}`];
      // A missing answer must never drop content.
      probabilities.push(typeof answer?.noul === "number" ? answer.noul : 1);
    }
    return probabilities;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
