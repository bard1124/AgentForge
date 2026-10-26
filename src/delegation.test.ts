import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChange, defaultDelegation, delegationFile, type ExecutorFacts, heartbeatFile, promptContext, readDelegation, writeDelegation } from "./delegation.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deleg-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const facts: Record<string, ExecutorFacts> = {
  cursor: {
    permissions: ["sandbox", "auto-review"],
    models: [
      { id: "opus", effortParam: "effort", efforts: ["low", "high", "max"] },
      { id: "gpt", effortParam: "reasoning", efforts: ["low", "high"] },
      { id: "composer", efforts: [] },
    ],
  },
  echo: { permissions: [] },
};

describe("reading settings", () => {
  it("defaults to off with SDD on, and reads old files without the SDD field as on", () => {
    expect(readDelegation(home).settings).toMatchObject({ enabled: false, executor: "cursor", sdd: { enabled: true, workspace: path.join(home, "sdd") } });
    fs.writeFileSync(delegationFile(home), JSON.stringify({ enabled: true, executor: "cursor" }));
    expect(readDelegation(home).settings).toMatchObject({ enabled: true, sdd: { enabled: true } });
  });

  it("treats a corrupt file as off with SDD off", () => {
    fs.writeFileSync(delegationFile(home), "{ not json");
    const read = readDelegation(home);
    expect(read.corrupt).toBeTruthy();
    expect(read.settings.enabled).toBe(false);
    expect(read.settings.sdd.enabled).toBe(false);
    expect(promptContext(read)).toMatch(/OFF \(settings unreadable/);
  });

  it("drops an effort stored without a fixed model", () => {
    fs.writeFileSync(delegationFile(home), JSON.stringify({ enabled: true, executor: "cursor", effort: "high" }));
    expect(readDelegation(home).settings.effort).toBeUndefined();
  });
});

describe("applyChange", () => {
  const base = defaultDelegation("/h");

  it("checks model and effort against the catalog and clears an effort the new model lacks", () => {
    let s = applyChange(base, { model: "opus", effort: "max" }, facts);
    expect(s).toMatchObject({ route: { model: "opus" }, effort: "max" });
    s = applyChange(s, { model: "gpt" }, facts);
    expect(s.effort).toBeUndefined();
    s = applyChange(s, { effort: "high" }, facts);
    expect(s.effort).toBe("high");
    expect(() => applyChange(s, { model: "nope" }, facts)).toThrow(/not in the cursor catalog/);
    expect(() => applyChange(applyChange(s, { model: "composer" }, facts), { effort: "low" }, facts)).toThrow(/offers no effort options/);
    expect(() => applyChange(base, { effort: "high" }, facts)).toThrow(/fixed model/);
    expect(applyChange(s, { model: null }, facts)).not.toHaveProperty("route");
  });

  it("refuses new model selections while the catalog is unavailable but still turns off", () => {
    const offline = { cursor: { permissions: facts.cursor!.permissions } };
    const on = { ...base, enabled: true, route: { model: "opus" } };
    expect(() => applyChange(on, { model: "gpt" }, offline)).toThrow(/catalog is unavailable/);
    expect(applyChange(on, { enabled: false }, offline).enabled).toBe(false);
  });

  it("resets model, effort, and permission when switching executor", () => {
    const s = applyChange(base, { model: "opus", effort: "low", permission: "sandbox" }, facts);
    const switched = applyChange(s, { executor: "echo" }, facts);
    expect(switched).toMatchObject({ executor: "echo" });
    expect(switched).not.toHaveProperty("route");
    expect(switched).not.toHaveProperty("effort");
    expect(switched).not.toHaveProperty("permission");
    expect(() => applyChange(switched, { permission: "sandbox" }, facts)).toThrow(/does not support/);
    expect(() => applyChange(base, { executor: "nope" }, facts)).toThrow(/Unknown executor/);
    expect(applyChange(s, { permission: "default" }, facts)).not.toHaveProperty("permission");
  });

  it("requires an absolute SDD workspace", () => {
    expect(() => applyChange(base, { sddWorkspace: "relative/dir" }, facts)).toThrow(/absolute/);
    expect(applyChange(base, { sddWorkspace: "~/docs/sdd", sddEnabled: false }, facts).sdd).toEqual({ enabled: false, workspace: path.join(os.homedir(), "docs/sdd") });
  });
});

describe("prompt hook", () => {
  const hook = path.resolve("dist/hook.js");
  const runHook = () => {
    const res = spawnSync(process.execPath, [hook, "--home", home], { input: JSON.stringify({ session_id: "s1", cwd: "/x", prompt: "secret prompt" }), encoding: "utf8" });
    return { code: res.status, context: JSON.parse(res.stdout).hookSpecificOutput.additionalContext as string };
  };

  it("adds OFF or ON context from the current settings, writes a heartbeat, and never records the prompt", () => {
    let res = runHook();
    expect(res.code).toBe(0);
    expect(res.context).toMatch(/auto-dispatch: OFF/);
    writeDelegation(home, { ...defaultDelegation(home), enabled: true, route: { model: "opus" }, effort: "high" });
    res = runHook();
    expect(res.context).toMatch(/auto-dispatch: ON \(executor cursor, model opus, effort high/);
    expect(res.context).toMatch(/order_id/);
    expect(res.context).toMatch(/SDD task documents are ON/);
    const beat = fs.readFileSync(heartbeatFile(home), "utf8");
    expect(beat).toContain('"sessionId":"s1"');
    expect(beat).not.toContain("secret prompt");
    writeDelegation(home, { ...defaultDelegation(home), enabled: true, sdd: { enabled: false, workspace: home } });
    expect(runHook().context).not.toMatch(/SDD/);
  });

  it("exits 0 with OFF context even when the home is missing", () => {
    const res = spawnSync(process.execPath, [hook], { input: "", encoding: "utf8", env: { PATH: process.env.PATH } });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/OFF/);
  });
});
