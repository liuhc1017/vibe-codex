import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config/loadConfig.js";

describe("auth config hardening", () => {
  it("loads a relay-specific model override without changing global Codex settings", () => {
    expect(loadConfig({ NODE_ENV: "test", CODEX_MODEL: " example-model " }).codexModel).toBe("example-model");
    expect(loadConfig({ NODE_ENV: "test", CODEX_MODEL: " " }).codexModel).toBeUndefined();
  });
  it("supports OAuth-only production without generating a bearer credential", () => {
    const config = loadConfig({ NODE_ENV: "production", ENABLE_EXPERIMENTAL_OAUTH: "true" });
    expect(config.relayToken).toBeUndefined();
    expect(config.disableAuth).toBe(false);
    expect(config.controlPort).not.toBe(config.port);
  });

  it("rejects invalid or overlapping private/public ports", () => {
    for (const ports of [{ PORT: "8788", CONTROL_PORT: "8788" }, { PORT: "0" }, { CONTROL_PORT: "65536" }, { PORT: "8787oops" }, { PORT: "1.5" }, { CONTROL_PORT: "invalid" }]) {
      expect(() => loadConfig({ NODE_ENV: "test", ...ports })).toThrow(/distinct ports/);
    }
  });
  it("rejects short URL tokens when URL token auth is enabled", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "vibe_short",
      URL_TOKEN_MIN_LENGTH: "32",
    })).toThrow(/shorter/);
  });

  it("rejects URL tokens that do not match the required prefix", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "wrong_prefix_token_that_is_long_enough",
      URL_TOKEN_REQUIRED_PREFIX: "vibe_",
      URL_TOKEN_MIN_LENGTH: "32",
    })).toThrow(/PREFIX/);
  });

  it("accepts a long prefixed URL token", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "vibe_0123456789abcdef0123456789abcdef",
      URL_TOKEN_MIN_LENGTH: "32",
    });
    expect(config.allowUrlTokenAuth).toBe(true);
    expect(config.urlToken).toBe("vibe_0123456789abcdef0123456789abcdef");
  });

  it("rejects malformed URL token expiry timestamps", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      ALLOW_URL_TOKEN_AUTH: "true",
      URL_TOKEN: "vibe_0123456789abcdef0123456789abcdef",
      URL_TOKEN_EXPIRES_AT: "not-a-date",
    })).toThrow(/ISO timestamp/);
  });

  it("expands home-relative allowed root examples", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ALLOWED_ROOTS: "~/Projects,~/codex-work",
      DEFAULT_PARENT_DIR: "~/codex-work",
    });
    expect(config.allowedRoots).toContain(path.join(os.homedir(), "Projects"));
    expect(config.defaultParentDir).toBe(path.join(os.homedir(), "codex-work"));
  });

  it("loads and validates DEFAULT_VISIBLE_MODE", () => {
    expect(loadConfig({ NODE_ENV: "test" }).defaultVisibleMode).toBe("codex-app-visible");
    expect(loadConfig({ NODE_ENV: "test", DEFAULT_VISIBLE_MODE: "ghostty-visible" }).defaultVisibleMode).toBe("ghostty-visible");
    expect(() => loadConfig({ NODE_ENV: "test", DEFAULT_VISIBLE_MODE: "exec-hidden" })).toThrow(/DEFAULT_VISIBLE_MODE/);
  });
});
