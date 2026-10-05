import { ChildProcess, spawn } from "node:child_process";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  timedOut: boolean;
  command: string;
  cwd?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export function decodeBoundedUtf8(buffer: Buffer, maxBytes = buffer.length): string {
  // stream:true drops an incomplete final codepoint instead of growing it into U+FFFD.
  let text = new TextDecoder().decode(buffer, { stream: true });
  if (Buffer.byteLength(text) > maxBytes) {
    text = new TextDecoder().decode(Buffer.from(text).subarray(0, maxBytes), { stream: true });
  }
  return text;
}

export function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals, processGroup: boolean) {
  if (processGroup && child.pid && process.platform !== "win32") {
    try { process.kill(-child.pid, signal); return; } catch { /* Fall back if the group already exited. */ }
  }
  if (!hasProcessExited(child)) child.kill(signal);
}

/** Wait for an actual exit, not child.killed (which only records a sent signal). */
export async function terminateProcess(child: ChildProcess, graceMs = 2_000, processGroup = false): Promise<void> {
  if (hasProcessExited(child)) return;
  await new Promise<void>((resolve) => {
    let killTimer: NodeJS.Timeout;
    let finalTimer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      child.removeListener("exit", done);
      if (processGroup && hasProcessExited(child)) signalProcess(child, "SIGKILL", true);
      resolve();
    };
    child.once("exit", done);
    signalProcess(child, "SIGTERM", processGroup);
    killTimer = setTimeout(() => {
      if (!hasProcessExited(child)) signalProcess(child, "SIGKILL", processGroup);
      finalTimer = setTimeout(done, 1_000);
    }, graceMs);
  });
}

export function runProcessArgv(args: {
  file: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  stdin?: string | Buffer;
}): Promise<ProcessResult> {
  const startedAt = new Date();
  const requestedLimit = args.maxOutputBytes ?? 200_000;
  const maxOutputBytes = Number.isFinite(requestedLimit) ? Math.max(0, Math.floor(requestedLimit)) : 200_000;
  const command = [args.file, ...(args.args ?? [])].join(" ");
  const streams = { stdout: { chunks: [] as Buffer[], bytes: 0, truncated: false }, stderr: { chunks: [] as Buffer[], bytes: 0, truncated: false } };
  const append = (stream: keyof typeof streams, chunk: Buffer) => {
    const state = streams[stream];
    const remaining = Math.max(0, maxOutputBytes - state.bytes);
    if (chunk.length > remaining) state.truncated = true;
    if (remaining) {
      const kept = chunk.subarray(0, remaining);
      state.chunks.push(kept);
      state.bytes += kept.length;
    }
  };
  let timedOut = false;
  return new Promise((resolve) => {
    // Own a process group so timeout also terminates build/test subprocesses.
    const processGroup = process.platform !== "win32";
    const child = spawn(args.file, args.args ?? [], {
      cwd: args.cwd, env: { ...process.env, ...args.env }, detached: processGroup,
      stdio: [args.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let finalTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (finalTimer) clearTimeout(finalTimer);
      const finishedAt = new Date();
      resolve({ exitCode, signal, stdout: decodeBoundedUtf8(Buffer.concat(streams.stdout.chunks), maxOutputBytes), stderr: decodeBoundedUtf8(Buffer.concat(streams.stderr.chunks), maxOutputBytes), stdoutTruncated: streams.stdout.truncated, stderrTruncated: streams.stderr.truncated, timedOut, command, cwd: args.cwd, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: finishedAt.getTime() - startedAt.getTime() });
    };
    const timer = args.timeoutMs && args.timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      signalProcess(child, "SIGTERM", processGroup);
      killTimer = setTimeout(() => {
        // Even an exited leader may have descendants holding its output pipes open.
        signalProcess(child, "SIGKILL", processGroup);
        finalTimer = setTimeout(() => {
          child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy();
          finish(child.exitCode, child.signalCode);
        }, 1_000);
      }, 2_000);
    }, args.timeoutMs) : undefined;
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => append("stderr", Buffer.from(error.message)));
    child.stdin?.on("error", (error) => append("stderr", Buffer.from(error.message)));
    if (args.stdin != null && child.stdin) child.stdin.end(args.stdin);
    child.on("close", finish);
  });
}

export function runProcess(args: { command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }): Promise<ProcessResult> {
  return runProcessArgv({ ...args, file: args.command, args: [] });
}

/** Only for internally authored scripts. Never use with user-supplied workspace commands. */
export function runShellCommand(args: { command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string> }): Promise<ProcessResult> {
  return runProcessArgv({ ...args, file: process.platform === "win32" ? "cmd.exe" : "/bin/sh", args: process.platform === "win32" ? ["/d", "/s", "/c", args.command] : ["-c", args.command] }).then((result) => ({ ...result, command: args.command }));
}
