/** Rough token count without a tokenizer: about 4 ASCII chars per token, and one per non-ASCII char (CJK is ~1 token each). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}
