import { describe, expect, it } from "vitest";
import { estimateTokens } from "./tokens.js";

describe("estimateTokens", () => {
  it("counts about four ASCII chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens('{"task_id":"cf-1"}')).toBe(5);
  });

  it("counts one token per CJK char, plus the ASCII around it", () => {
    expect(estimateTokens("派工")).toBe(2);
    expect(estimateTokens("ok 派工")).toBe(3);
  });

  it("is zero for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });
});
