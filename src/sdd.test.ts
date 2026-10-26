import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultDelegation, delegationFile, writeDelegation } from "./delegation.js";
import { SddStore } from "./sdd.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cf-sdd-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("SddStore", () => {
  it("creates projects by name and tasks with a template or given plan, under the workspace", () => {
    const sdd = new SddStore(home);
    const dir = path.join(home, "sdd");
    const p = sdd.createProject("Billing", dir);
    expect(sdd.createProject("billing").id).toBe(p.id);
    const t = sdd.createTask(p.id, { title: "Cancel button", createdBy: "board" }, dir);
    expect(t.content).toMatch(/^# Cancel button\n\n## Goal/);
    expect(t.path).toBe(path.join(dir, p.id, t.id, "task.md"));
    expect(fs.existsSync(path.join(dir, p.id, "project.json"))).toBe(true);
    const planned = sdd.createTask(p.id, { title: "Export", content: "# Export CSV\n\nplan", createdBy: "claude" });
    expect(planned.title).toBe("Export CSV");
    expect(sdd.listTasks(p.id).map((x) => x.id).sort()).toEqual([t.id, planned.id].sort());
    expect(sdd.listProjects()).toMatchObject([{ name: "Billing", tasks: 2 }]);
  });

  it("saves against the read revision and refuses a stale one", () => {
    const sdd = new SddStore(home);
    const p = sdd.createProject("P");
    const t = sdd.createTask(p.id, { title: "T", createdBy: "board" });
    const saved = sdd.saveTask(p.id, t.id, "# T\n\nv2", t.revision);
    expect(saved.content).toBe("# T\n\nv2");
    expect(() => sdd.saveTask(p.id, t.id, "# T\n\nother editor", t.revision)).toThrow(/changed since revision/);
    expect(sdd.readTask(p.id, t.id).content).toBe("# T\n\nv2");
  });

  it("refuses writes while SDD is off or the settings are corrupt, but still reads", () => {
    const sdd = new SddStore(home);
    const p = sdd.createProject("P");
    const t = sdd.createTask(p.id, { title: "T", createdBy: "board" });
    writeDelegation(home, { ...defaultDelegation(home), sdd: { enabled: false, workspace: path.join(home, "sdd") } });
    expect(() => sdd.createProject("Q")).toThrow(/switched off/);
    expect(() => sdd.saveTask(p.id, t.id, "x", t.revision)).toThrow(/switched off/);
    expect(sdd.readTask(p.id, t.id).id).toBe(t.id);
    fs.writeFileSync(delegationFile(home), "{");
    expect(() => sdd.createTask(p.id, { title: "U", createdBy: "claude" })).toThrow(/unreadable/);
  });

  it("rejects requests made against a workspace the settings moved away from, and bad ids", () => {
    const sdd = new SddStore(home);
    const p = sdd.createProject("P");
    const other = path.join(home, "elsewhere");
    writeDelegation(home, { ...defaultDelegation(home), sdd: { enabled: true, workspace: other } });
    expect(() => sdd.listProjects(path.join(home, "sdd"))).toThrow(/workspace changed/);
    expect(sdd.listProjects(other)).toEqual([]);
    expect(() => sdd.readTask("../../etc", p.id)).toThrow(/Invalid project id/);
    expect(() => sdd.readTask(p.id, "../x")).toThrow(/No SDD project|Invalid task id/);
  });
});
