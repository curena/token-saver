const MIN_RATIO = 2;
const MAX_RATIO = 8;

export function estimateTokens(text: string, charsPerToken = 4): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerToken));
}

export function calibrateCharsPerToken(
  samples: Array<{ chars: number; tokens: number }>,
  fallback = 4,
): number {
  let chars = 0;
  let tokens = 0;
  for (const sample of samples) {
    chars += sample.chars;
    tokens += sample.tokens;
  }
  if (tokens <= 0) return fallback;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, chars / tokens));
}
