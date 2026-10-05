import { randomUUID } from "node:crypto";
import { Config } from "../config/types.js";
import Database from "better-sqlite3";

export type ActionRisk = "read" | "write" | "execute" | "codex-visible" | "codex-hidden" | "dangerous";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "consumed" | "expired";

export interface ApprovalRecord {
  id: string;
  status: ApprovalStatus;
  reason: string;
  actionRisk: ActionRisk;
  actionKey: string;
  actionSummary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  rejectionReason?: string;
}

export class ApprovalStore {
  private approvals = new Map<string, ApprovalRecord>();
  private db?: Database.Database;

  constructor(databasePath?: string) {
    if (!databasePath) return;
    this.db = new Database(databasePath);
    this.db.exec("CREATE TABLE IF NOT EXISTS local_approvals (id TEXT PRIMARY KEY, record_json TEXT NOT NULL)");
    const rows = this.db.prepare("SELECT record_json FROM local_approvals").all() as { record_json: string }[];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as ApprovalRecord;
      this.approvals.set(record.id, record);
    }
    this.expire();
  }

  private save(record: ApprovalRecord) {
    this.db?.prepare("INSERT OR REPLACE INTO local_approvals (id, record_json) VALUES (?, ?)").run(record.id, JSON.stringify(record));
  }

  private expire() {
    for (const record of this.approvals.values()) {
      if ((record.status === "pending" || record.status === "approved") && (!record.expiresAt || Date.parse(record.expiresAt) <= Date.now())) {
        record.status = "expired";
        this.save(record);
      }
    }
  }

  close() {
    this.db?.close();
    this.db = undefined;
  }

  create(args: { reason: string; actionRisk: ActionRisk; actionSummary: Record<string, unknown> }): ApprovalRecord {
    this.expire();
    const key = actionKey(args.actionRisk, args.actionSummary);
    const existing = [...this.approvals.values()].find((record) => record.status === "pending" && record.actionKey === key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const record: ApprovalRecord = {
      id: randomUUID(),
      status: "pending",
      reason: args.reason,
      actionRisk: args.actionRisk,
      actionKey: actionKey(args.actionRisk, args.actionSummary),
      actionSummary: args.actionSummary,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    this.approvals.set(record.id, record);
    this.save(record);
    return record;
  }

  approve(id: string): ApprovalRecord | null {
    this.expire();
    const record = this.approvals.get(id);
    if (!record || record.status !== "pending") return null;
    record.status = "approved";
    record.updatedAt = new Date().toISOString();
    this.save(record);
    return record;
  }

  reject(id: string, reason?: string): ApprovalRecord | null {
    this.expire();
    const record = this.approvals.get(id);
    if (!record || record.status !== "pending") return null;
    record.status = "rejected";
    record.rejectionReason = reason;
    record.updatedAt = new Date().toISOString();
    this.save(record);
    return record;
  }

  list(status?: ApprovalStatus): ApprovalRecord[] {
    this.expire();
    return [...this.approvals.values()]
      .filter((record) => !status || record.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  consumeApproved(actionRisk: ActionRisk, actionSummary: Record<string, unknown>): boolean {
    this.expire();
    const key = actionKey(actionRisk, actionSummary);
    for (const record of this.approvals.values()) {
      if (record.status === "approved" && record.actionKey === key) {
        record.status = "consumed";
        record.updatedAt = new Date().toISOString();
        this.save(record);
        return true;
      }
    }
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function actionKey(actionRisk: ActionRisk, actionSummary: Record<string, unknown>): string {
  return `${actionRisk}:${stableStringify(actionSummary)}`;
}

export function approvalRequired(record: ApprovalRecord) {
  return {
    approvalRequired: true,
    approvalId: record.id,
    reason: record.reason,
    actionSummary: record.actionSummary,
    nextStep: "Approve this exact action in the local Vibe Codex control page, then retry the tool call.",
    expiresAt: record.expiresAt,
  };
}

export function requiresApproval(config: Config, actionRisk: ActionRisk): boolean {
  if (actionRisk === "codex-visible") return config.requireApprovalForCodexVisible;
  if (actionRisk === "codex-hidden") return config.requireApprovalForCodexHidden;
  if (actionRisk === "write") return config.requireApprovalForWriteFile;
  if (actionRisk === "execute") return config.requireApprovalForNormalCommands;
  if (actionRisk === "dangerous") return true;
  return false;
}
