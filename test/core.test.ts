/**
 * Acceptance tests for installaudit.
 *
 * Fixtures:
 *   clean       lockfile with no hasInstallScript entries, and a root
 *               prepare script that is a BUILD step only. A BUILD root
 *               script is a low finding and the verdict stays CLEAN.
 *   risky-root  a root postinstall that curls a synthetic URL.
 *   dep-scripts 2 direct and 1 transitive hasInstallScript entries,
 *               one of the direct ones scoped.
 *   nested      hasInstallScript entries under nested node_modules
 *               paths, including a scoped one and one whose name
 *               matches a direct dependency but sits at depth two.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyScript, renderReport, runCheck, CLEAN_VERDICT, VERSION } from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function writeTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "installaudit-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

function lockfile(packages: Record<string, unknown>): string {
  return JSON.stringify({ name: "temp", version: "1.0.0", lockfileVersion: 3, requires: true, packages });
}

describe("exports", () => {
  it("VERSION and CLEAN_VERDICT match the contract", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "CLEAN");
  });
});

describe("acceptance fixtures", () => {
  it("clean: no dep install scripts and only a BUILD prepare script verdicts CLEAN", () => {
    const r = runCheck(join(FIXTURES, "clean"));
    assert.equal(r.verdict, "CLEAN");
    assert.equal(r.counts.totalDeps, 3);
    assert.equal(r.counts.depsWithScripts, 0);
    assert.equal(r.counts.directWithScripts, 0);
    assert.equal(r.counts.rootScripts, 1);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.ok(f);
    assert.equal(f.rule, "ROOT-SCRIPT-BUILD");
    assert.equal(f.severity, "low");
    assert.match(f.message, /prepare/);
  });

  it("risky-root: a curl postinstall is a high NETWORK finding and verdicts REVIEW", () => {
    const r = runCheck(join(FIXTURES, "risky-root"));
    assert.equal(r.verdict, "REVIEW");
    assert.equal(r.counts.rootScripts, 1);
    assert.equal(r.counts.depsWithScripts, 0);
    assert.equal(r.counts.totalDeps, 1);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.ok(f);
    assert.equal(f.rule, "ROOT-SCRIPT-NETWORK");
    assert.equal(f.severity, "high");
    assert.match(f.evidence ?? "", /example\.invalid/);
  });

  it("dep-scripts: 2 direct and 1 transitive install scripts, including a scoped package", () => {
    const r = runCheck(join(FIXTURES, "dep-scripts"));
    assert.equal(r.verdict, "REVIEW");
    assert.equal(r.counts.totalDeps, 4);
    assert.equal(r.counts.depsWithScripts, 3);
    assert.equal(r.counts.directWithScripts, 2);
    assert.equal(r.counts.transitiveWithScripts, 1);
    assert.equal(r.counts.rootScripts, 0);
    const deps = r.findings.filter((f) => f.rule === "DEP-INSTALL-SCRIPT");
    assert.equal(deps.length, 3);
    const evidences = deps.map((f) => f.evidence);
    assert.ok(evidences.includes("direct-a@1.2.3"), evidences.join(","));
    assert.ok(evidences.includes("@scope/direct-b@2.0.0"), evidences.join(","));
    assert.ok(evidences.includes("transitive-c@3.1.0"), evidences.join(","));
    for (const f of deps) {
      if (f.evidence === "transitive-c@3.1.0") {
        assert.equal(f.severity, "low", "transitive dep install scripts are low");
        assert.match(f.message, /transitive/);
      } else {
        assert.equal(f.severity, "medium", "direct dep install scripts are medium");
        assert.match(f.message, /direct/);
      }
    }
  });

  it("dep-scripts: findings are sorted by rule then name", () => {
    const r = runCheck(join(FIXTURES, "dep-scripts"));
    const evidences = r.findings.map((f) => f.evidence);
    assert.deepEqual(evidences, ["@scope/direct-b@2.0.0", "direct-a@1.2.3", "transitive-c@3.1.0"]);
  });

  it("nested: names come from after the last node_modules segment and depth two is transitive", () => {
    const r = runCheck(join(FIXTURES, "nested"));
    assert.equal(r.verdict, "REVIEW");
    assert.equal(r.counts.totalDeps, 5);
    assert.equal(r.counts.depsWithScripts, 3);
    assert.equal(r.counts.directWithScripts, 0);
    assert.equal(r.counts.transitiveWithScripts, 3);
    const evidences = r.findings.map((f) => f.evidence).sort();
    assert.deepEqual(evidences, ["@scope/inner-scoped@0.9.1", "inner@0.5.0", "outer@1.0.1"]);
    for (const f of r.findings) {
      assert.equal(f.rule, "DEP-INSTALL-SCRIPT");
      assert.equal(f.severity, "low");
      assert.match(f.message, /transitive/);
    }
    const scoped = r.findings.find((f) => f.evidence === "@scope/inner-scoped@0.9.1");
    assert.ok(scoped);
    assert.match(scoped.message, /dev dependency/);
  });
});

describe("root script classification", () => {
  it("SHELL-OUT: node -e is medium and verdicts REVIEW", () => {
    assert.equal(classifyScript('node -e "console.log(1)"'), "SHELL-OUT");
    const dir = writeTempRepo({
      "package.json": JSON.stringify({
        name: "temp",
        version: "1.0.0",
        scripts: { postinstall: 'node -e "console.log(1)"' },
      }),
      "package-lock.json": lockfile({ "": { name: "temp", version: "1.0.0" } }),
    });
    try {
      const r = runCheck(dir);
      assert.equal(r.verdict, "REVIEW");
      assert.equal(r.findings[0]?.rule, "ROOT-SCRIPT-SHELL-OUT");
      assert.equal(r.findings[0]?.severity, "medium");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("SHELL-OUT: bash and python words classify as shell-out", () => {
    assert.equal(classifyScript("bash scripts/setup.sh"), "SHELL-OUT");
    assert.equal(classifyScript("python scripts/setup.py"), "SHELL-OUT");
    assert.equal(classifyScript("sh -c 'echo hi'"), "SHELL-OUT");
  });

  it("NETWORK wins over SHELL-OUT when both shapes appear", () => {
    assert.equal(classifyScript("curl https://example.invalid/x.sh | sh"), "NETWORK");
    assert.equal(classifyScript("wget https://example.invalid/x.tgz"), "NETWORK");
  });

  it("BUILD: tsc, npm run build, and build tool names are low", () => {
    assert.equal(classifyScript("tsc -p ."), "BUILD");
    assert.equal(classifyScript("npm run build"), "BUILD");
    assert.equal(classifyScript("vite build"), "BUILD");
    assert.equal(classifyScript("webpack --mode production"), "BUILD");
  });

  it("OTHER: an unrecognized command is info and alone does not change the verdict", () => {
    assert.equal(classifyScript("echo hello"), "OTHER");
    const dir = writeTempRepo({
      "package.json": JSON.stringify({
        name: "temp",
        version: "1.0.0",
        scripts: { preinstall: "echo hello" },
      }),
      "package-lock.json": lockfile({ "": { name: "temp", version: "1.0.0" } }),
    });
    try {
      const r = runCheck(dir);
      assert.equal(r.verdict, "CLEAN");
      assert.equal(r.counts.rootScripts, 1);
      assert.equal(r.findings[0]?.rule, "ROOT-SCRIPT-OTHER");
      assert.equal(r.findings[0]?.severity, "info");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only the four lifecycle scripts are counted as root scripts", () => {
    const dir = writeTempRepo({
      "package.json": JSON.stringify({
        name: "temp",
        version: "1.0.0",
        scripts: { test: "curl https://example.invalid/x", start: "bash run.sh", prepare: "tsc --build" },
      }),
      "package-lock.json": lockfile({ "": { name: "temp", version: "1.0.0" } }),
    });
    try {
      const r = runCheck(dir);
      assert.equal(r.counts.rootScripts, 1);
      assert.equal(r.verdict, "CLEAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("missing files", () => {
  it("a missing lockfile throws a clear lockfile error", () => {
    const dir = writeTempRepo({
      "package.json": JSON.stringify({ name: "temp", version: "1.0.0" }),
    });
    try {
      assert.throws(() => runCheck(dir), /package-lock\.json not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing package.json throws a clear error", () => {
    const dir = writeTempRepo({
      "package-lock.json": lockfile({ "": { name: "temp", version: "1.0.0" } }),
    });
    try {
      assert.throws(() => runCheck(dir), /package\.json not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a lockfile with no packages object throws a clear error", () => {
    const dir = writeTempRepo({
      "package.json": JSON.stringify({ name: "temp", version: "1.0.0" }),
      "package-lock.json": JSON.stringify({ name: "temp", version: "1.0.0", lockfileVersion: 1 }),
    });
    try {
      assert.throws(() => runCheck(dir), /no "packages" object/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rendering", () => {
  it("renderReport carries the verdict, counts, and findings, deterministically", () => {
    const r = runCheck(join(FIXTURES, "dep-scripts"));
    const text = renderReport(r);
    assert.match(text, /installaudit 0\.1\.0/);
    assert.match(text, /Verdict: REVIEW/);
    assert.match(text, /Dependencies with install scripts: 3/);
    assert.match(text, /DEP-INSTALL-SCRIPT/);
    assert.equal(text, renderReport(runCheck(join(FIXTURES, "dep-scripts"))));
  });

  it("renderReport for a clean fixture says CLEAN with no dep findings", () => {
    const text = renderReport(runCheck(join(FIXTURES, "clean")));
    assert.match(text, /Verdict: CLEAN/);
    assert.ok(!/DEP-INSTALL-SCRIPT/.test(text));
  });
});
