/**
 * installaudit core.
 *
 * Inventories install-time code execution for a repo from two files at
 * the target: package.json and package-lock.json. The lockfile is the
 * source of truth for dependencies: in lockfile v2 and v3 the
 * "packages" object maps install paths such as "node_modules/<name>"
 * to entries, and an entry with "hasInstallScript": true runs code at
 * install time. The script bodies of dependencies are not in the
 * lockfile, so for dependencies only presence is reported, never the
 * body and never intent.
 *
 * The root package is different: its own lifecycle scripts are in
 * package.json, so their command bodies can be classified. The
 * scripts read are preinstall, install, postinstall, and prepare.
 * Each body is classified by the first matching class in this fixed
 * priority order:
 *
 *   NETWORK    curl or wget, or an http:// or https:// URL combined
 *              with a fetch or download tool word (fetch, download,
 *              curl, wget).
 *   SHELL-OUT  a shell interpreter word (sh, bash, zsh), node -e, or
 *              a script interpreter word (python, python3, perl,
 *              ruby).
 *   BUILD      tsc, npm run build (also pnpm, yarn, and bun), or a
 *              known build tool name (webpack, vite, rollup,
 *              esbuild, parcel, gulp, grunt, babel).
 *   OTHER      anything else.
 *
 * Verdict is CLEAN when there are no NETWORK or SHELL-OUT root
 * scripts and no dependency install scripts, and REVIEW otherwise.
 * A BUILD or OTHER root script alone does not change the verdict.
 *
 * Findings are sorted deterministically by rule, then by the name
 * they are about (package name for dependencies, script name for
 * root scripts), then by evidence. Reports carry no timestamps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Report, Severity } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "CLEAN";
export const REVIEW_VERDICT = "REVIEW";

const ROOT_SCRIPT_NAMES = ["preinstall", "install", "postinstall", "prepare"] as const;

type ScriptClass = "NETWORK" | "SHELL-OUT" | "BUILD" | "OTHER";

const CLASS_SEVERITY: Record<ScriptClass, Severity> = {
  NETWORK: "high",
  "SHELL-OUT": "medium",
  BUILD: "low",
  OTHER: "info",
};

const NETWORK_TOOL_WITH_URL = /\b(fetch|download|curl|wget)\b/i;
const URL_PATTERN = /https?:\/\//i;
const NETWORK_TOOL = /\b(curl|wget)\b/i;
const SHELL_OUT_PATTERNS: RegExp[] = [
  /\b(sh|bash|zsh)\b/i,
  /\bnode\s+-e\b/i,
  /\b(python3?|perl|ruby)\b/i,
];
const BUILD_PATTERNS: RegExp[] = [
  /\btsc\b/i,
  /\b(npm|pnpm|yarn|bun)\s+run\s+build\b/i,
  /\b(webpack|vite|rollup|esbuild|parcel|gulp|grunt|babel)\b/i,
];

export function classifyScript(command: string): ScriptClass {
  if (NETWORK_TOOL.test(command)) return "NETWORK";
  if (URL_PATTERN.test(command) && NETWORK_TOOL_WITH_URL.test(command)) return "NETWORK";
  for (const pattern of SHELL_OUT_PATTERNS) {
    if (pattern.test(command)) return "SHELL-OUT";
  }
  for (const pattern of BUILD_PATTERNS) {
    if (pattern.test(command)) return "BUILD";
  }
  return "OTHER";
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

interface LockEntry {
  version?: unknown;
  dev?: unknown;
  hasInstallScript?: unknown;
}

interface Lockfile {
  packages?: Record<string, LockEntry>;
}

function readJsonFile(path: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read ${label} at ${path}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label} at ${path}: ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the package name from a lockfile install path: the segment
 * after the last "node_modules/" segment. A scoped name takes two
 * segments, for example "node_modules/@scope/name" and
 * "node_modules/a/node_modules/@scope/name" both end in a scoped
 * name, the second one being "@scope/name".
 */
function packageNameFromPath(path: string): string | null {
  const segments = path.split("/");
  const last = segments.lastIndexOf("node_modules");
  if (last === -1) return null;
  const rest = segments.slice(last + 1).filter((s) => s.length > 0);
  if (rest.length === 0) return null;
  const first = rest[0] as string;
  if (first.startsWith("@")) {
    if (rest.length < 2) return first;
    return `${first}/${rest[1] as string}`;
  }
  return first;
}

function countNodeModulesSegments(path: string): number {
  return path.split("/").filter((s) => s === "node_modules").length;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface SortableFinding {
  finding: Finding;
  sortName: string;
}

export function runCheck(target: string): Report {
  const packageJsonPath = join(target, "package.json");
  const lockfilePath = join(target, "package-lock.json");

  if (!existsSync(packageJsonPath)) {
    throw new Error(
      `package.json not found at ${packageJsonPath}: installaudit needs a package.json to inventory install scripts`,
    );
  }
  if (!existsSync(lockfilePath)) {
    throw new Error(
      `package-lock.json not found at ${lockfilePath}: installaudit is lockfile-based and cannot inventory install scripts without it`,
    );
  }

  const packageJsonRaw = readJsonFile(packageJsonPath, "package.json");
  if (!isRecord(packageJsonRaw)) {
    throw new Error(`package.json at ${packageJsonPath} is not a JSON object`);
  }
  const packageJson = packageJsonRaw as PackageJson;

  const lockRaw = readJsonFile(lockfilePath, "package-lock.json");
  if (!isRecord(lockRaw)) {
    throw new Error(`package-lock.json at ${lockfilePath} is not a JSON object`);
  }
  const lockfile = lockRaw as Lockfile;
  if (!isRecord(lockfile.packages)) {
    throw new Error(
      `package-lock.json at ${lockfilePath} has no "packages" object: installaudit supports lockfile v2 and v3 only`,
    );
  }

  const directNames = new Set<string>();
  for (const deps of [packageJson.dependencies, packageJson.devDependencies]) {
    if (isRecord(deps)) {
      for (const name of Object.keys(deps)) directNames.add(name);
    }
  }

  const sortable: SortableFinding[] = [];

  // Root lifecycle scripts: bodies are readable, so classify them.
  const scripts: Record<string, string> = isRecord(packageJson.scripts)
    ? (packageJson.scripts as Record<string, string>)
    : {};
  let rootScripts = 0;
  let hasRiskyRootScript = false;
  for (const scriptName of ROOT_SCRIPT_NAMES) {
    const command = scripts[scriptName];
    if (typeof command !== "string" || command.trim() === "") continue;
    rootScripts += 1;
    const scriptClass = classifyScript(command);
    if (scriptClass === "NETWORK" || scriptClass === "SHELL-OUT") {
      hasRiskyRootScript = true;
    }
    sortable.push({
      sortName: scriptName,
      finding: {
        rule: `ROOT-SCRIPT-${scriptClass}`,
        severity: CLASS_SEVERITY[scriptClass],
        file: "package.json",
        message: `Root ${scriptName} script is classified as ${scriptClass} and runs at install time: ${command}`,
        evidence: command,
      },
    });
  }

  // Dependency install scripts: presence only, from the lockfile.
  let totalDeps = 0;
  let depsWithScripts = 0;
  let directWithScripts = 0;
  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (path === "") continue;
    const name = packageNameFromPath(path);
    if (name === null) continue;
    totalDeps += 1;
    if (!isRecord(entry) || entry.hasInstallScript !== true) continue;
    depsWithScripts += 1;
    const version = typeof entry.version === "string" ? entry.version : "unknown";
    const dev = entry.dev === true;
    const direct = countNodeModulesSegments(path) === 1 && directNames.has(name);
    if (direct) directWithScripts += 1;
    sortable.push({
      sortName: name,
      finding: {
        rule: "DEP-INSTALL-SCRIPT",
        severity: direct ? "medium" : "low",
        file: "package-lock.json",
        message: `Dependency ${name}@${version} has an install script (hasInstallScript in the lockfile), is ${direct ? "direct" : "transitive"}${dev ? ", and is a dev dependency" : ""}. Its script body is not in the lockfile and is not fetched.`,
        evidence: `${name}@${version}`,
      },
    });
  }

  sortable.sort(
    (a, b) =>
      compareStrings(a.finding.rule, b.finding.rule) ||
      compareStrings(a.sortName, b.sortName) ||
      compareStrings(a.finding.evidence ?? "", b.finding.evidence ?? "") ||
      compareStrings(a.finding.message, b.finding.message),
  );
  const findings = sortable.map((s) => s.finding);

  const transitiveWithScripts = depsWithScripts - directWithScripts;
  const verdict =
    !hasRiskyRootScript && depsWithScripts === 0 ? CLEAN_VERDICT : REVIEW_VERDICT;

  const counts: Record<string, number> = {
    totalDeps,
    depsWithScripts,
    directWithScripts,
    transitiveWithScripts,
    rootScripts,
    findings: findings.length,
  };

  const summary = `${totalDeps} dependencies inventoried, ${depsWithScripts} with install scripts (${directWithScripts} direct, ${transitiveWithScripts} transitive), ${rootScripts} root lifecycle scripts: ${verdict}`;

  return {
    tool: "installaudit",
    version: VERSION,
    target,
    verdict,
    counts,
    findings,
    summary,
  };
}

export function renderReport(report: Report): string {
  const counts = report.counts;
  const num = (key: string): number => counts[key] ?? 0;

  const lines: string[] = [];
  lines.push(`installaudit ${report.version}`);
  lines.push(`Target: ${report.target}`);
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Summary: ${report.summary}`);
  lines.push("");
  lines.push("Counts:");
  lines.push(`  Total dependencies: ${num("totalDeps")}`);
  lines.push(`  Dependencies with install scripts: ${num("depsWithScripts")}`);
  lines.push(`  Direct dependencies with install scripts: ${num("directWithScripts")}`);
  lines.push(`  Transitive dependencies with install scripts: ${num("transitiveWithScripts")}`);
  lines.push(`  Root lifecycle scripts: ${num("rootScripts")}`);
  lines.push(`  Findings: ${num("findings")}`);
  lines.push("");
  lines.push("Findings:");
  if (report.findings.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of report.findings) {
      const where = f.file ? ` ${f.file}` : "";
      const evidence = f.evidence ? ` [${f.evidence}]` : "";
      lines.push(`  [${f.severity.toUpperCase()}] ${f.rule}${where}: ${f.message}${evidence}`);
    }
  }
  return lines.join("\n");
}
