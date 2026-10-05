export type CommandRisk = "safe" | "normal" | "dangerous" | "blocked";

export interface CommandRiskResult {
  risk: CommandRisk;
  reason: string;
  /** Present only for a fully validated, executable command. Never pass command to a shell. */
  argv?: string[];
  pathOperands?: string[];
}

/** Deliberately not a shell parser: only words and whole, simply quoted words. */
export function tokenizeCommand(command: string): string[] {
  if (/[\n\r\x00-\x1f\x7f;$`|&<>\\(){}*?\[\]~#]/.test(command)) {
    throw new Error("Shell composition, expansion, substitution and redirection are blocked.");
  }
  const words: string[] = [];
  let offset = 0;
  while (offset < command.length) {
    while (command[offset] === " ") offset++;
    if (offset === command.length) break;
    const quote = command[offset] === "'" || command[offset] === '"' ? command[offset++] : undefined;
    const start = offset;
    if (quote) {
      while (offset < command.length && command[offset] !== quote) offset++;
      if (offset === command.length) throw new Error("Unterminated quote.");
      words.push(command.slice(start, offset++));
      if (offset < command.length && command[offset] !== " ") throw new Error("Quoted words cannot be concatenated.");
    } else {
      while (offset < command.length && command[offset] !== " ") {
        if (command[offset] === "'" || command[offset] === '"') throw new Error("Quotes must surround a whole word.");
        offset++;
      }
      words.push(command.slice(start, offset));
    }
  }
  if (!words.length || words.some((word) => !word)) throw new Error("Empty command or argument.");
  return words;
}

const plainPath = (value: string) => !value.startsWith("-") && !value.includes(":") && !value.includes("=");

function flagsAndPaths(words: string[], allowed: (flag: string) => boolean, requireSeparator = false): string[] | undefined {
  const paths: string[] = [];
  let separator = false;
  for (const word of words) {
    if (word === "--" && !separator) { separator = true; continue; }
    if (!separator && word.startsWith("-")) {
      if (!allowed(word)) return undefined;
    } else {
      if ((requireSeparator && !separator) || !plainPath(word)) return undefined;
      paths.push(word);
    }
  }
  return paths;
}

export function classifyCommand(command: string): CommandRiskResult {
  let argv: string[];
  try { argv = tokenizeCommand(command); }
  catch (error) { return { risk: "blocked", reason: (error as Error).message }; }
  const [file, subcommand, ...rest] = argv;
  const blocked = (reason: string): CommandRiskResult => ({ risk: "blocked", reason });
  const unsupported = (): CommandRiskResult => ({ risk: "dangerous", reason: "Command or flags are outside the executable argv allowlist; this operation will not run." });
  const valid = (paths: string[] = [], normal = false): CommandRiskResult => ({
    risk: normal ? "normal" : "safe",
    reason: normal ? "Executes arbitrary trusted repository build/test code; requires build-test or full-project autonomy." : "Validated read-only argv command.",
    argv, pathOperands: paths,
  });
  if (["sudo", "nc", "ncat", "netcat", "eval", "exec"].includes(file)) return blocked("Privileged, network-shell or interpreter commands are blocked.");
  if (["sh", "bash", "zsh", "node", "python", "python3", "perl", "ruby"].includes(file) && argv.some((word) => word === "-e" || word === "-c")) return blocked("Inline interpreter execution is blocked.");
  if (file === "rm" && argv.some((word) => word === "/")) return blocked("Destructive system path access is blocked.");
  if (file === "pwd" && argv.length === 1) return valid();
  if (["node", "npm", "python", "python3"].includes(file) && argv.length === 2 && subcommand === "--version") return valid();
  if (file === "ls") {
    const paths = flagsAndPaths(argv.slice(1), (flag) => /^-[alhAdF1]+$/.test(flag));
    return paths ? valid(paths.length ? paths : ["."]) : unsupported();
  }
  if (file === "find") {
    if (argv.length !== 7 || !plainPath(subcommand ?? "") || argv[2] !== "-maxdepth" || !/^(?:[1-9]|[1-9][0-9])$/.test(argv[3]) || argv[4] !== "-type" || argv[5] !== "f" || argv[6] !== "-print") {
      // The traditional six-word form uses find's implicit -print.
      if (argv.length !== 6 || !plainPath(subcommand ?? "") || argv[2] !== "-maxdepth" || !/^(?:[1-9]|[1-9][0-9])$/.test(argv[3]) || argv[4] !== "-type" || argv[5] !== "f") return unsupported();
    }
    return valid([subcommand]);
  }
  if (file === "git") {
    let paths: string[] | undefined;
    if (subcommand === "status") paths = flagsAndPaths(rest, (flag) => ["--short", "-s", "--porcelain", "--porcelain=v1", "--branch", "-b", "--untracked-files=all", "--untracked-files=normal", "--untracked-files=no"].includes(flag), true);
    if (subcommand === "diff") paths = flagsAndPaths(rest, (flag) => ["--stat", "--shortstat", "--numstat", "--name-only", "--name-status", "--summary", "--check", "--cached", "--staged", "--no-ext-diff", "--no-textconv"].includes(flag) || /^(?:-U|--unified=)(?:[0-9]|[1-9][0-9])$/.test(flag), true);
    if (subcommand === "log" && rest.includes("--oneline")) paths = flagsAndPaths(rest, (flag) => flag === "--oneline" || /^(?:-n|--max-count=)[1-9][0-9]{0,2}$/.test(flag), true);
    return paths ? valid(paths) : unsupported();
  }
  if (file === "npm") {
    if (subcommand === "test" || (subcommand === "run" && ["build", "lint", "test"].includes(rest[0]))) {
      const extra = subcommand === "test" ? rest : rest.slice(1);
      if (!extra.length) return valid([], true);
      if (extra[0] !== "--") return unsupported();
      const paths = flagsAndPaths(extra.slice(1), (flag) => ["--run", "--watch=false", "--runInBand", "--coverage", "--no-coverage", "-q", "-v"].includes(flag));
      return paths ? valid(paths, true) : unsupported();
    }
  }
  if (file === "pytest" || file === "vitest") {
    const words = file === "vitest" && subcommand === "run" ? rest : argv.slice(1);
    const paths = flagsAndPaths(words, (flag) => ["-q", "-v", "--verbose", "--run", "--coverage", "--watch=false", "--disable-warnings", "--no-header", "--no-summary"].includes(flag));
    return paths ? valid(paths, true) : unsupported();
  }
  return unsupported();
}
