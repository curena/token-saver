import { homedir } from "node:os";
import { join } from "node:path";
import { emergencyLevel, loadConfig, turnLevel } from "@token-saver/prune";
import type { Config, SweepEntryData } from "@token-saver/prune";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { handleContext } from "./context.js";
import type { Arming, PiMessage } from "./context.js";
import { readReserveTokens } from "./settings.js";
import { sdkClient } from "./jev.js";
import { recall, sessionSource } from "./recall.js";
import { DecisionStore, RESTORE_ENTRY, SWEEP_ENTRY } from "./state.js";
import type { RestoreEntryData } from "./state.js";
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
  const reserveTokens = readReserveTokens([
    join(homedir(), ".pi", "agent", "settings.json"),
    join(process.cwd(), ".pi", "settings.json"),
  ]);
  let arming: Arming = { turnArmAt: null, emergencyArmAt: null };
  let lastUsage: { tokens: number; window: number } | null = null;
  // Why lastUsage is null, for /token-saver.
  let usageNote = "context size unknown until the next response";
  let jevTokens = 0;
  let recalls = 0;

  const JEV_PRICE_PER_TOKEN = 0.042 / 1e6;

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    store.rebuildFrom(ctx.sessionManager.buildContextEntries());
    arming = { turnArmAt: null, emergencyArmAt: null };
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
    const raw = ctx.getContextUsage?.();
    const usage =
      raw && typeof raw.tokens === "number" && typeof raw.contextWindow === "number" && raw.contextWindow > 0
        ? { tokens: raw.tokens, window: raw.contextWindow }
        : null;
    lastUsage = usage;
    // pi reports null tokens right after compaction, until the next response.
    const windowKnown = raw && typeof raw.contextWindow === "number" && raw.contextWindow > 0;
    usageNote = windowKnown
      ? "context size unknown until the next response"
      : "context window unknown, not sweeping";

    const outcome = await handleContext({
      messages: event.messages as PiMessage[],
      store,
      config,
      client,
      usage,
      reserveTokens,
      arming,
      signal: ctx.signal,
    });

    arming = outcome.arming;
    if (outcome.sweep !== null) jevTokens += outcome.sweep.jevInputTokens;

    if (outcome.sweep !== null && outcome.sweep.decisions.length > 0 && outcome.trigger !== null) {
      const data: SweepEntryData = {
        decisions: outcome.sweep.decisions,
        trigger: outcome.trigger,
        at: new Date().toISOString(),
      };
      pi.appendEntry(SWEEP_ENTRY, data);
    }
    return outcome.messages === null ? undefined : { messages: outcome.messages };
  });

  pi.registerEntryRenderer(SWEEP_ENTRY, (entry: { data: SweepEntryData }) => new Text(renderSweepEntry(entry.data)));
  pi.registerEntryRenderer(RESTORE_ENTRY, (entry: { data: RestoreEntryData }) =>
    new Text(`token-saver: restored ${entry.data?.id} in full (kept from now on)`));

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Restore the full text of a tool result that token-saver shortened. Use the id from a " +
      "[token-saver] marker. startLine/endLine fetch part of a file read. Call this instead of " +
      "guessing, or re-running the command, when you need elided detail.",
    parameters: Type.Object({
      id: Type.String({ description: "Tool call id from the [token-saver] marker" }),
      startLine: Type.Optional(Type.Number({ description: "First file line (inclusive), as numbered in the elided markers" })),
      endLine: Type.Optional(Type.Number({ description: "Last file line (inclusive), as numbered in the elided markers" })),
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
        // Pin the result as permanently kept, and persist that so rebuildFrom honors it
        // on reload: otherwise the sweep entry would bring the stub back, or a later
        // sweep would re-shorten it (a second cache reset).
        const restored = store.restore(id);
        if (restored) pi.appendEntry(RESTORE_ENTRY, { id } satisfies RestoreEntryData);
        ctx.ui.notify(
          restored
            ? `token-saver restored ${id} (one cache reset)`
            : `token-saver has no decision for ${id}`,
          "info",
        );
        return;
      }
      const stats = store.stats();
      const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
      let levels = usageNote;
      if (lastUsage !== null) {
        const { tokens, window } = lastUsage;
        const turnAt = arming.turnArmAt ?? turnLevel(window, reserveTokens, config) * window;
        const emergencyAt = arming.emergencyArmAt ?? emergencyLevel(window, reserveTokens, config.contextLevel) * window;
        levels =
          `context ${k(tokens)}/${k(window)} (${((tokens / window) * 100).toFixed(0)}%), ` +
          `next sweep at ${k(turnAt)} on your message, emergency ${k(emergencyAt)}, target ${k(config.lowWater * window)}`;
      }
      ctx.ui.notify(
        `token-saver: ${levels}. ${stats.stubbed} stubbed, ${stats.partial} partial, ` +
        `~${k(stats.savedTokens)} tokens freed, ${recalls} recalls, ` +
        `jev spend ~$${(jevTokens * JEV_PRICE_PER_TOKEN).toFixed(4)}` +
        (client === null ? " (TYPESAFE_API_KEY not set)" : !config.enabled ? " (off)" : ""),
        "info",
      );
    },
  });
}
