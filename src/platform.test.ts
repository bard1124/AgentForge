import { describe, expect, it } from "vitest";
import { commandLine, isWindows } from "./platform.js";

describe("commandLine", () => {
  it.runIf(!isWindows)("runs commands directly outside Windows", () => {
    expect(commandLine("claude", ["plugin", "install", "a b"])).toEqual({ file: "claude", args: ["plugin", "install", "a b"], shell: false });
  });

  it.runIf(isWindows)("quotes .cmd shims for cmd.exe on Windows", () => {
    expect(commandLine("claude", ["plugin", "marketplace", "add", "C:\\Users\\A B\\.agentforge\\marketplace", 'say "hi"'])).toEqual({
      file: 'claude plugin marketplace add "C:\\Users\\A B\\.agentforge\\marketplace" "say ""hi"""',
      args: [],
      shell: true,
    });
  });

  it.runIf(isWindows)("runs .exe files directly on Windows", () => {
    expect(commandLine("C:\\node\\node.exe", ["-v"]).shell).toBe(false);
  });
});
