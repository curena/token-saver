import { Jev } from "@token-saver/core";
import type { JevClient } from "@token-saver/core";
import type { Chunk, Config, ResultRef } from "./types.js";

// Re-exported because the pi extension and the replay harness both implement a client, and
// prune is the package they depend on. The type itself lives in core, so the audit and the
// pruner send through one wrapper -- which is what gives the pruner its redaction.
export type { JevClient };

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

/**
 * The only value interpolated here is a chunk's own index -- a small integer this module
 * generated. Nothing from the session reaches the question text, which is how this builder
 * satisfies core's redaction contract: `Jev.ask` redacts `state` and not `questions`, so a
 * builder either redacts its interpolations or has none. This one has none.
 */
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

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Ask Jev which chunks are still needed, through the shared wrapper.
 *
 * Going through `Jev` rather than calling the client directly is what redacts the tool-result
 * text: `ask` runs every string in `state` through the redaction pass before the request
 * leaves the machine, and `buildRequest` puts the chunks in `state`. The request built here
 * is never mutated, so `render` and `recall` still restore the original, unredacted lines --
 * the masked copy exists only for the duration of the call.
 *
 * The wrapper is constructed per call. Its in-memory cache is therefore empty every time,
 * which is deliberate: the same result judged in a later sweep has a different task and a
 * different `after_result`, so a cross-sweep cache would almost never hit. The replay
 * harness, where repeats are the whole point, caches on disk in its own client instead.
 *
 * Every failure -- an aborted sweep, an over-budget call, an HTTP error, a malformed body --
 * arrives here as `null` from `ask` and leaves as `null`, so the sweep falls back to a
 * code-only decision.
 */
export async function judgeResult(
  client: JevClient,
  request: JevRequest,
  chunkCount: number,
  config: Config,
  signal?: AbortSignal,
): Promise<number[] | null> {
  const jev = new Jev({ client, deadlineMs: config.jevBudgetMs });
  const answers = await jev.ask(request.state, request.questions, {
    model: request.model,
    signal,
  });
  if (answers === null) return null;

  const probabilities: number[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const answer = answers[`chunk::${index}`];
    // A missing OR malformed answer must never drop content. `typeof` alone
    // admits NaN and out-of-range numbers, and both read as "drop" once they
    // meet the keep threshold, so the range is checked here.
    probabilities.push(isProbability(answer?.noul) ? answer.noul : 1);
  }
  return probabilities;
}
