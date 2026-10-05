import { loadConfig } from "../src/config/loadConfig.js";
import { collectDiagnostics } from "../src/server/diagnostics.js";

try {
  const diagnostics = await collectDiagnostics(loadConfig());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(diagnostics, null, 2));
  } else {
    console.log("\nVibe Codex readiness\n");
    for (const check of diagnostics.checks) console.log(`${check.ok ? "✓" : "○"} ${check.name}\n  ${check.detail}\n`);
    console.log(`Local workbench: ${diagnostics.localControlUrl}\nAuthentication: ${diagnostics.connector.authentication}`);
    console.log(diagnostics.connector.mcpUrl ? `Connector: ${diagnostics.connector.mcpUrl}` : "Connector: set PUBLIC_BASE_URL to your HTTPS tunnel.");
    console.log("\nThis check does not start Codex, execute tasks, or verify ChatGPT connectivity.");
  }
  if (diagnostics.checks.some((check) => !check.ok)) process.exitCode = 1;
} catch (error) {
  console.error(`Setup needs attention: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Copy .env.example to .env, configure authentication and allowed project folders, then run npm run doctor again.");
  process.exitCode = 1;
}
