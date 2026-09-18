const PLACEHOLDER = "[REDACTED]";

/** Token-like literals: provider key prefixes, then JWTs. */
const KEY_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk|ghp|gho|ghs|github_pat|xoxb|xoxp|AKIA|ASIA)[-_][A-Za-z0-9\-_]{8,}/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
];

/** NAME=value or NAME: value where the name looks secret-ish. */
const ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g;

const DENYLIST: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/,
  /(^|\/)id_[A-Za-z0-9_]+$/,
  /(^|\/)secrets(\/|$)/,
];

/**
 * True when a high-entropy run looks like a credential rather than prose or code.
 *
 * Known false-positive class: long mixed-case identifiers (e.g.
 * `getUserProfileByIdV2EndpointHandler123456`) and base64-ish checksums (e.g. an
 * npm `sha512-...` integrity hash) can satisfy this heuristic without being
 * secrets. This is a deliberate recall-over-precision tradeoff: this function's
 * output is only ever sent to Jev, never shown to the agent or the user (they
 * always see the original, unredacted text), so an over-eager mask costs Jev some
 * context rather than leaking anything. Precision gets tuned in Milestone 2
 * against the eval harness, with data instead of a guess.
 */
function looksRandom(word: string): boolean {
  if (word.length < 24) return false;
  if (!/^[A-Za-z0-9+/=_\-]+$/.test(word)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/].filter((re) => re.test(word)).length;
  if (classes < 3) return false;
  const unique = new Set(word).size;
  return unique / word.length > 0.5;
}

export function redact(text: string): string {
  let out = text;
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, PLACEHOLDER);
  out = out.replace(ASSIGNMENT, (_m, name: string) => `${name}=${PLACEHOLDER}`);
  out = out.replace(/[A-Za-z0-9+/=_\-]{24,}/g, (word) =>
    looksRandom(word) ? PLACEHOLDER : word,
  );
  return out;
}

export function isDenylistedPath(path: string): boolean {
  return DENYLIST.some((re) => re.test(path));
}
