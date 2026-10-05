import { describe, expect, it } from "vitest";
import { runProcessArgv } from "../src/util/spawn.js";

describe("bounded process execution", () => {
  it("enforces output byte limits across repeated multibyte chunks", async () => {
    const result = await runProcessArgv({ file: process.execPath, args: ["-e", "for(let i=0;i<10;i++)process.stdout.write('界'.repeat(1000))"], maxOutputBytes: 101, timeoutMs: 3_000 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(101);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("�");
  });
  it("escalates a SIGTERM-ignoring child to SIGKILL after timeout", async () => {
    const result = await runProcessArgv({ file: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"], timeoutMs: 300 });
    expect(result.stdout).toContain("ready");
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.durationMs).toBeLessThan(4_000);
  }, 6_000);
  it("does not leave descendants holding stdout open after timeout", async () => {
    const result = await runProcessArgv({ file: process.execPath, args: ["-e", `require('child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`], timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(4_000);
  }, 6_000);
});
