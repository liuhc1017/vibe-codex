import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface LaunchAgent {
  label: string;
  script: string;
  stdout: string;
  stderr: string;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function launchAgentEnvironment(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const nodeBin = env.NODE_BIN || process.execPath;
  const result: Record<string, string> = {
    PATH: [path.dirname(nodeBin), env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"].filter(Boolean).join(":"),
    NODE_BIN: nodeBin,
    VIBE_CODEX_REPO_DIR: repoRoot,
  };
  for (const key of ["NPM_BIN", "NGROK_BIN", "PORT", "CONTROL_PORT", "PUBLIC_BASE_URL", "CODEX_APP_SERVER_PORT"]) {
    if (env[key]) result[key] = env[key]!;
  }
  return result;
}

export function buildLaunchAgentPlist(agent: LaunchAgent, repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const environment = Object.entries(launchAgentEnvironment(repoRoot, env)).map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(agent.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xml(agent.script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(repoRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(agent.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(agent.stderr)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
</dict>
</plist>
`;
}

function main() {
  // Resolve correctly both under tsx scripts/ and compiled dist/scripts/.
  const parent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = path.resolve(process.env.VIBE_CODEX_REPO_DIR ?? (fs.existsSync(path.join(parent, "package.json")) ? parent : path.dirname(parent)));
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || uid == null) throw new Error("LaunchAgents are supported only on macOS.");
  const logDir = path.join(repoRoot, ".vibe-codex", "launchd");
  const agents: LaunchAgent[] = [
    { label: "com.vibecodex.server", script: path.join(repoRoot, "scripts", "start-vibe-codex-service.sh"), stdout: path.join(logDir, "server.stdout.log"), stderr: path.join(logDir, "server.stderr.log") },
    { label: "com.vibecodex.ngrok", script: path.join(repoRoot, "scripts", "start-vibe-codex-ngrok.sh"), stdout: path.join(logDir, "ngrok.stdout.log"), stderr: path.join(logDir, "ngrok.stderr.log") },
  ];
  const plistPath = (label: string) => path.join(launchAgentsDir, `${label}.plist`);
  const run = (args: string[], allowFailure = false) => {
    const result = spawnSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
    if (result.status !== 0 && !allowFailure) throw new Error(`launchctl ${args.join(" ")} failed\n${result.error?.message ?? ""}\n${result.stdout}${result.stderr}`);
    return result;
  };
  const bootout = (label: string) => {
    run(["bootout", `gui/${uid}`, plistPath(label)], true);
    run(["bootout", `gui/${uid}/${label}`], true);
  };
  // Importing this file for tests and invoking it without arguments cannot install/restart anything.
  const command = process.argv[2] ?? "status";
  if (command === "install") {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
    fs.mkdirSync(logDir, { recursive: true });
    for (const agent of agents) {
      fs.writeFileSync(plistPath(agent.label), buildLaunchAgentPlist(agent, repoRoot), { mode: 0o600 });
      bootout(agent.label);
      run(["enable", `gui/${uid}/${agent.label}`], true);
      run(["bootstrap", `gui/${uid}`, plistPath(agent.label)]);
      console.log(`installed ${agent.label}`);
    }
    console.log(`logs: ${logDir}`);
  } else if (command === "uninstall") {
    for (const agent of agents) {
      bootout(agent.label);
      fs.rmSync(plistPath(agent.label), { force: true });
      console.log(`removed ${agent.label}`);
    }
  } else if (command === "status") {
    for (const agent of agents) {
      const result = run(["print", `gui/${uid}/${agent.label}`], true);
      console.log(`\n## ${agent.label}`);
      if (result.status === 0) {
        const useful = result.stdout.split("\n").filter((line) => /\b(state|pid|last exit code|program|path|KeepAlive)\b/i.test(line)).slice(0, 20).join("\n");
        console.log(useful || result.stdout.slice(0, 1200));
      } else console.log("not loaded");
    }
  } else throw new Error("Usage: tsx scripts/installLaunchAgents.ts [install|uninstall|status]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
