import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Config } from "../config/types.js";
import { VibeError } from "../util/errors.js";

const home = os.homedir();

const sensitiveHomeDirs = [
  ".ssh",
  ".codex",
  path.join("Library", "Keychains"),
  path.join("Library", "Application Support", "Google", "Chrome"),
  path.join("Library", "Application Support", "BraveSoftware"),
  path.join("Library", "Application Support", "Firefox"),
  path.join("Library", "Application Support", "Microsoft Edge"),
  path.join("Library", "Cookies"),
];

const sensitiveFilePatterns = [
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|[/\\])\.env($|[.])/i,
  /id_rsa$/i,
  /id_ed25519$/i,
  /cookies?(\.sqlite|\.db)?$/i,
  /login data$/i,
  /keychain/i,
  /(^|[/\\])(?:\.ssh|\.codex|\.git)([/\\]|$)/i,
  /(^|[/\\])(?:auth\.json|credentials(?:\.json)?|\.npmrc|\.netrc)($|[/\\])/i,
];

async function resolveExistingAware(inputPath: string): Promise<string> {
  let ancestor = path.resolve(inputPath);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling link is not a nonexistent directory we may safely create through.
      const stat = await fs.lstat(ancestor).catch((lstatError: NodeJS.ErrnoException) => {
        if (lstatError.code !== "ENOENT") throw lstatError;
        return undefined;
      });
      if (stat?.isSymbolicLink()) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Cannot resolve a dangling symlink safely.", { path: ancestor });
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function isSensitivePath(resolvedPath: string): boolean {
  const normalized = path.resolve(resolvedPath);
  for (const rel of sensitiveHomeDirs) {
    const target = path.join(home, rel);
    if (isInside(normalized, target)) return true;
  }
  return sensitiveFilePatterns.some((pattern) => pattern.test(normalized));
}

export async function isPathInsideAllowedRoots(resolvedPath: string, config: Config): Promise<boolean> {
  const candidate = await resolveExistingAware(resolvedPath);
  const roots = await Promise.all(config.allowedRoots.map((root) => resolveExistingAware(root)));
  return roots.some((root) => isInside(candidate, root));
}

export async function resolveInsideAllowedRoots(inputPath: string, config: Config): Promise<string> {
  const expanded = inputPath.replace(/^~(?=$|[/\\])/, home);
  const resolved = await resolveExistingAware(expanded);
  if (isSensitivePath(path.resolve(expanded)) || isSensitivePath(resolved)) {
    throw new VibeError("SENSITIVE_PATH_BLOCKED", "Sensitive path access is blocked.", { path: resolved });
  }
  if (!(await isPathInsideAllowedRoots(resolved, config))) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Path is outside allowed roots.", {
      path: resolved,
      allowedRoots: config.allowedRoots,
    });
  }
  return resolved;
}

export async function assertSafeWorkspacePath(inputPath: string, config: Config): Promise<string> {
  return resolveInsideAllowedRoots(inputPath, config);
}

export async function assertSafeFilePath(workspacePath: string, relativePath: string, config: Config): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path must be relative to the workspace.", { relativePath });
  }
  const workspace = await assertSafeWorkspacePath(workspacePath, config);
  const rawTarget = path.resolve(workspace, relativePath);
  const target = await resolveExistingAware(rawTarget);
  if (!isInside(target, workspace)) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path escapes the workspace.", { path: target, workspace });
  }
  if (isSensitivePath(rawTarget) || isSensitivePath(target)) {
    throw new VibeError("SENSITIVE_PATH_BLOCKED", "Sensitive file access is blocked.", { path: target });
  }
  if (!(await isPathInsideAllowedRoots(target, config))) {
    throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "File path is outside allowed roots.", { path: target });
  }
  return target;
}

/** A lexical path inside the workspace whose existing components contain no symlinks. */
export async function assertSafeNonSymlinkFilePath(workspacePath: string, relativePath: string, config: Config): Promise<string> {
  const workspace = await assertSafeWorkspacePath(workspacePath, config);
  const target = await assertSafeFilePath(workspace, relativePath, config);
  const rawTarget = path.resolve(workspace, relativePath);
  if (!isInside(rawTarget, workspace)) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Path escapes the workspace.");
  let current = workspace;
  const relative = path.relative(workspace, rawTarget);
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new VibeError("PATH_OUTSIDE_ALLOWED_ROOTS", "Symlink operands are not allowed.", { path: current });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
  return target;
}
