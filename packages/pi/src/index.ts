import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@token-saver/core";
import type { Config, Prices, SweepEntryData } from "@token-saver/core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { handleContext } from "./context.js";
import type { PiMessage } from "./context.js";
import { sdkClient } from "./jev.js";
import { recall, sessionSource } from "./recall.js";
import { DecisionStore, SWEEP_ENTRY } from "./state.js";
import { renderSweepEntry } from "./ui.js";

const GUIDELINE =
  "Older tool results may appear shortened, marked `[token-saver] … elided …`. The full text " +
  "is still available: call recall with the id shown to get it back, with optional " +
  "startLine/endLine. Recall when you need details, and don't guess at elided content.";

export default function extension(pi: any) {
  const store = new DecisionStore();
  let config: Config = loadConfig({
    files: [join(homedir(), ".pi", "token-saver.json"), join(process.cwd(), ".pi", "token-saver.json")],
  });
  const client = sdkClient(process.env.TYPESAFE_API_KEY);
  let callsSoFar = 0;
  let cooldownUntilTurn = 0;
  let lastForcedFraction: number | null = null;
  let lastForcedEligible: number | null = null;
  let jevTokens = 0;
  let recalls = 0;

  const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

  // Both price shapes are handled: per-token values are < 0.001, per-Mtok values are
  // >= 0.001 (divide the latter by 1e6). The live unit probe (Step 1) was not run here,
  // so confirm ctx.model.cost in a real session before trusting the cost gate.
  const priceOf = (ctx: any): Prices | null => {
    const cost = ctx.model?.cost;
    if (cost === undefined || typeof cost.cacheWrite !== "number" || cost.cacheWrite === 0) return null;
    const scale = cost.input > 0.001 ? 1e6 : 1;
    return { input: cost.input / scale, cacheRead: cost.cacheRead / scale, cacheWrite: cost.cacheWrite / scale };
  };

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    store.rebuildFrom(ctx.sessionManager.buildContextEntries());
    if (client === null) {
      ctx.ui?.notify?.("token-saver: TYPESAFE_API_KEY is not set, staying inert", "warn");
    }
  });

  pi.on("session_tree", async (_event: unknown, ctx: any) => {
    store.rebuildFrom(ctx.sessionManager.buildContextEntries());
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!config.enabled || client === null) return;
    const options = event.systemPromptOptions;
    if (options?.promptGuidelines && !options.promptGuidelines.includes(GUIDELINE)) {
      options.promptGuidelines.push(GUIDELINE); // added once; pi patches only changed sections
    }
  });

  pi.on("context", async (event: any, ctx: any) => {
    callsSoFar++;
    const usage = ctx.getContextUsage?.();
    const fraction =
      usage && typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && usage.contextWindow > 0
        ? usage.tokens / usage.contextWindow
        : null;

    const outcome = await handleContext({
      messages: event.messages as PiMessage[],
      store,
      config,
      client,
      prices: priceOf(ctx),
      contextFraction: fraction,
      callsSoFar,
      lastForcedFraction,
      lastForcedEligible,
      cooldownUntilTurn,
      signal: ctx.signal,
    });

    cooldownUntilTurn = outcome.cooldownUntilTurn;
    lastForcedFraction = outcome.lastForcedFraction;
    lastForcedEligible = outcome.lastForcedEligible;
    if (outcome.sweep !== null) jevTokens += outcome.sweep.jevInputTokens;

    if (outcome.sweep !== null && outcome.sweep.decisions.length > 0) {
      const data: SweepEntryData = {
        decisions: outcome.sweep.decisions,
        trigger: outcome.trigger ?? "cost",
        at: new Date().toISOString(),
      };
      pi.appendEntry(SWEEP_ENTRY, data);
    }
    return outcome.messages === null ? undefined : { messages: outcome.messages };
  });

  pi.registerEntryRenderer(SWEEP_ENTRY, (entry: { data: SweepEntryData }) => new Text(renderSweepEntry(entry.data)));

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Restore the full text of a tool result that token-saver shortened. Use the id from a " +
      "[token-saver] marker. startLine/endLine fetch part of a file read. Call this instead of " +
      "guessing, or re-running the command, when you need elided detail.",
    parameters: Type.Object({
      id: Type.String({ description: "Tool call id from the [token-saver] marker" }),
      startLine: Type.Optional(Type.Number({ description: "1-based first line (inclusive)" })),
      endLine: Type.Optional(Type.Number({ description: "1-based last line (inclusive)" })),
    }),
    async execute(
      _toolCallId: string,
      params: { id: string; startLine?: number; endLine?: number },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: any,
    ) {
      recalls++;
      const result = recall(sessionSource(ctx.sessionManager.getEntries()), params);
      if (result.isError) {
        // pi signals tool errors by throwing; the message is reported to the LLM.
        throw new Error(result.content[0].text);
      }
      return { content: result.content, details: {} };
    },
  });

  pi.registerCommand("token-saver", {
    description: "Show or change token-saver status",
    handler: async (args: string, ctx: any) => {
      const argument = args.trim();
      if (argument === "off" || argument === "on") {
        config = { ...config, enabled: argument === "on" };
        ctx.ui.notify(`token-saver ${argument}`, "info");
        return;
      }
      if (argument.startsWith("restore ")) {
        const id = argument.slice("restore ".length).trim();
        ctx.ui.notify(
          store.remove(id)
            ? `token-saver restored ${id} (one cache reset)`
            : `token-saver has no decision for ${id}`,
          "info",
        );
        return;
      }
      const stats = store.stats();
      ctx.ui.notify(
        `token-saver: ${stats.stubbed} stubbed, ${stats.partial} partial, ` +
        `~${(stats.savedTokens / 1000).toFixed(1)}k tokens freed, ${recalls} recalls, ` +
        `jev spend ~$${(jevTokens * JEV_PRICE_PER_TOKEN).toFixed(4)}`,
        "info",
      );
    },
  });
}
