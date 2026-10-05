import { describe, expect, it, vi } from "vitest";
import { tempConfig } from "./helpers.js";
import { ApprovalStore } from "../src/approvals/actionPolicy.js";

describe("approval store", () => {
  it("persists exact approval across restarts, consumes once, and cannot reapprove", async () => {
    const ctx = await tempConfig();
    let store = new ApprovalStore(ctx.config.databasePath);
    const summary = { tool: "write_file", contentHash: "content-one", workspacePath: ctx.root };
    try {
      const record = store.create({ reason: "write", actionRisk: "write", actionSummary: summary });
      expect(store.create({ reason: "retry", actionRisk: "write", actionSummary: summary }).id).toBe(record.id);
      store.approve(record.id);
      store.close();
      store = new ApprovalStore(ctx.config.databasePath);
      expect(store.consumeApproved("write", { ...summary, contentHash: "content-two" })).toBe(false);
      expect(store.consumeApproved("write", summary)).toBe(true);
      expect(store.approve(record.id)).toBeNull();
      store.close();
      store = new ApprovalStore(ctx.config.databasePath);
      expect(store.consumeApproved("write", summary)).toBe(false);
    } finally { store.close(); await ctx.cleanup(); }
  });

  it("expires both pending and approved actions after ten minutes", () => {
    const store = new ApprovalStore();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const pending = store.create({ reason: "write", actionRisk: "write", actionSummary: { action: 1 } });
      const approved = store.create({ reason: "write", actionRisk: "write", actionSummary: { action: 2 } });
      store.approve(approved.id);
      clock.mockReturnValue(now + 600_001);
      expect(store.approve(pending.id)).toBeNull();
      expect(store.consumeApproved("write", { action: 2 })).toBe(false);
      expect(store.list("expired")).toHaveLength(2);
    } finally { clock.mockRestore(); store.close(); }
  });
  it("approves, consumes once, and rejects missing reuse", () => {
    const store = new ApprovalStore();
    const summary = { tool: "start_codex_task", executionMode: "exec-hidden", workspacePath: "/tmp/repo" };
    const approval = store.create({ reason: "hidden codex", actionRisk: "codex-hidden", actionSummary: summary });
    expect(store.list("pending")).toHaveLength(1);
    expect(store.approve(approval.id)?.status).toBe("approved");
    expect(store.consumeApproved("codex-hidden", summary)).toBe(true);
    expect(store.consumeApproved("codex-hidden", summary)).toBe(false);
  });

  it("records rejection reason", () => {
    const store = new ApprovalStore();
    const approval = store.create({ reason: "write", actionRisk: "write", actionSummary: { tool: "write_file" } });
    const rejected = store.reject(approval.id, "not now");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejectionReason).toBe("not now");
  });
});
