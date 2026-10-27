import { AuthenticationError, ConfigurationError, NetworkError } from "@cursor/sdk";
import { describe, expect, it } from "vitest";
import { isRetryableError, isTransientMessage } from "./errors.js";
import { ForgeError } from "./forge.js";
import { describeError } from "./server.js";
import { toWorkerResult } from "./workers/cursor.js";

describe("toWorkerResult", () => {
  it("keeps the SDK's retry verdict when the run error carries one", () => {
    const run = (error: object) => toWorkerResult({ id: "r", status: "error", error } as never);
    expect(run({ message: "x", isRetryable: true }).retryable).toBe(true);
    expect(run({ message: "x", displayInfo: { isRetryable: false } }).retryable).toBe(false);
    expect(run({ message: "x" }).retryable).toBeUndefined();
  });
});

describe("isRetryableError", () => {
  it("treats network-class and connection-failure errors as retryable even when the SDK flag is false", () => {
    expect(new NetworkError("Service unavailable").isRetryable).toBe(false);
    expect(isRetryableError(new NetworkError("Service unavailable"))).toBe(true);
    expect(isRetryableError(new ConfigurationError("Network request failed"))).toBe(true);
    expect(isRetryableError(new Error("fetch failed"))).toBe(true);
  });

  it("treats the SDK's stopped-resume message as transient", () => {
    expect(isTransientMessage("Agent turn stopped after repeated resume attempts made no progress")).toBe(true);
    expect(isTransientMessage("The connection was interrupted repeatedly without saving progress")).toBe(true);
  });

  it("does not retry auth or plain configuration errors", () => {
    expect(isRetryableError(new AuthenticationError("fetch failed"))).toBe(false);
    expect(isRetryableError(new ConfigurationError("Unknown model id"))).toBe(false);
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });
});

describe("describeError", () => {
  it("keeps the retry verdict when a startup failure is wrapped", () => {
    const text = describeError(new ForgeError("Task cf-1 could not start: Network request failed", { cause: new NetworkError("Network request failed") }));
    expect(text).toContain("Task cf-1 could not start");
    expect(text).toContain("error_type: NetworkError");
    expect(text).toContain("retryable: true");
  });

  it("points auth failures at login", () => {
    expect(describeError(new AuthenticationError("401"))).toMatch(/retryable: false.*agentforge login/);
  });

  it("passes input errors through and flags unknown errors", () => {
    expect(describeError(new ForgeError("No task with id x"))).toBe("No task with id x");
    expect(describeError(new ConfigurationError("Unknown model id"))).toContain("retryable: false");
    expect(describeError(new Error("boom"))).toMatch(/^Unexpected error/);
  });
});
