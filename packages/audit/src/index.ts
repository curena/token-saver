// The setup-audit domain: what a skill costs, whether it fits, and what to propose.
// Harness-neutral -- the inventory and the settings file come from an adapter.
export { RECENT_USE_DAYS, proposeState } from "./policy.js";
export { fitQuestions, fitState, parseFit, FIT_BATCH_SIZE } from "./questions/fit.js";
export { buildProfile } from "./profile.js";
export { fingerprint } from "./fingerprint.js";
export { Store } from "./store.js";
export type { AuditEntry } from "./store.js";
export {
  judgeFit,
  buildProposals,
  renderProposals,
  applyProposals,
  undoLast,
  MalformedSettingsError,
} from "./run.js";
export type { FitLevel, InventoryItem, ProjectProfile, Proposal, SkillState } from "./types.js";
