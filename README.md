# installaudit

**Installing is running code. installaudit tells you whose code, before you install.**

`npm install` does not just download files. Any package whose lockfile entry carries `hasInstallScript: true` runs code at install time, and so do the root package's own `preinstall`, `install`, `postinstall`, and `prepare` scripts. Most audits ask whether a dependency is vulnerable. installaudit asks a prior question: what executes the moment you install this tree?

It reads `package.json` and `package-lock.json`, inventories every install script in the tree, separates direct dependencies from transitive ones, classifies the root scripts by what they do, and returns a verdict. It never installs anything, never runs a script, and never fetches a package.

## Install

```bash
npx @reneturcios/installaudit audit
```

Or install it globally, or add it as an MCP server (below).

## CLI

```bash
# Audit the current directory
npx @reneturcios/installaudit audit

# Audit another path
npx @reneturcios/installaudit audit ~/src/my-repo

# Machine readable output
npx @reneturcios/installaudit audit ~/src/my-repo --json

# Run as an MCP server on stdio
npx @reneturcios/installaudit mcp

# Print the version
npx @reneturcios/installaudit --version
```

Exit codes:

- `0` when the verdict is CLEAN.
- `1` when the verdict is REVIEW.
- `2` for usage errors, including a missing `package.json` or a missing `package-lock.json`.
- `141` when the reader closed the output pipe early.

## MCP

Add to your MCP client config:

```json
{
  "mcpServers": {
    "installaudit": {
      "command": "npx",
      "args": ["-y", "@reneturcios/installaudit", "mcp"]
    }
  }
}
```

Tool: `audit_install_scripts`, taking a `path` argument. It returns the full report as JSON: verdict, counts, and findings.

## How the inventory works

Dependencies come from the lockfile, not from `package.json` alone, because the lockfile is the resolved tree that will actually be installed.

- Lockfile v2 and v3 format: the `packages` object maps install paths such as `node_modules/<name>` to entries.
- An entry with `hasInstallScript: true` runs code at install time and becomes a finding.
- The package name is taken from the segment after the last `node_modules/` segment of the path. Scoped names take two segments: `node_modules/@scope/name` is `@scope/name`, and `node_modules/a/node_modules/@scope/name` is also `@scope/name`.
- A package is direct when its path has exactly one `node_modules` segment and its name is listed in the root `package.json` under `dependencies` or `devDependencies`. Everything else is transitive, including a nested copy whose name happens to match a direct dependency.
- The `version` and the `dev` flag are read from the lockfile entry and reported with the finding.

Root scripts come from `package.json`. Only `preinstall`, `install`, `postinstall`, and `prepare` are read, because those are the scripts npm runs around install. Each one present is a finding, classified from its command body.

## Rules

| rule | severity | what it means |
| --- | --- | --- |
| `DEP-INSTALL-SCRIPT` | medium (direct), low (transitive) | A dependency whose lockfile entry has `hasInstallScript: true`. Evidence is `name@version`. |
| `ROOT-SCRIPT-NETWORK` | high | A root lifecycle script classified as NETWORK. |
| `ROOT-SCRIPT-SHELL-OUT` | medium | A root lifecycle script classified as SHELL-OUT. |
| `ROOT-SCRIPT-BUILD` | low | A root lifecycle script classified as BUILD. |
| `ROOT-SCRIPT-OTHER` | info | A root lifecycle script classified as OTHER. |

Root script classification uses simple, documented patterns, checked in this priority order: NETWORK first, then SHELL-OUT, then BUILD, then OTHER.

| class | patterns |
| --- | --- |
| NETWORK | `curl` or `wget`, or an `http://` or `https://` URL combined with a fetch or download tool word (`fetch`, `download`, `curl`, `wget`). |
| SHELL-OUT | A shell interpreter word (`sh`, `bash`, `zsh`), `node -e`, or a script interpreter word (`python`, `python3`, `perl`, `ruby`). |
| BUILD | `tsc`, `npm run build` (also `pnpm`, `yarn`, and `bun`), or a build tool name (`webpack`, `vite`, `rollup`, `esbuild`, `parcel`, `gulp`, `grunt`, `babel`). |
| OTHER | Anything else. |

Counts reported in every report:

- `totalDeps`: every dependency entry found in the lockfile `packages` object, excluding the root entry.
- `depsWithScripts`: entries with `hasInstallScript: true`.
- `directWithScripts`: the direct subset of `depsWithScripts`.
- `transitiveWithScripts`: the transitive subset of `depsWithScripts`.
- `rootScripts`: root lifecycle scripts present among `preinstall`, `install`, `postinstall`, and `prepare`.
- `findings`: total findings.

Findings are sorted deterministically by rule, then by name. Reports contain no timestamps, so the same tree always produces the same report.

## Verdict

- `CLEAN`: no root NETWORK or SHELL-OUT scripts, and no dependency install scripts. A root BUILD or OTHER script alone still verdicts CLEAN; it is reported as a low or info finding, not hidden.
- `REVIEW`: anything else. At least one thing in this tree runs code at install time that is worth a human look.

## Limits

- Lockfile-based only. A missing `package-lock.json` is an error (exit 2), not an empty report, because without the lockfile there is no resolved tree to inventory. A missing `package.json` is likewise an error.
- Script bodies of dependencies are not in the lockfile and are not fetched. For a dependency, installaudit reports presence, name, version, dev flag, and direct or transitive position. It does not report what the script does and does not judge intent. A package with an install script may be entirely legitimate; native builds are the common case.
- Root script classification is pattern based. It reads the literal command text in `package.json`; it does not follow a script into the files it invokes, expand variables, or trace what a downloaded file would do.
- Only lockfile v2 and v3 are supported, through the `packages` object. The legacy lockfile v1 `dependencies` object is not read, so a v1 lockfile is an error rather than a half inventory.
- Only the four install-adjacent root scripts are read. Other scripts, such as `test` or `start`, are out of scope even when their commands look risky.
- Direct means listed in `dependencies` or `devDependencies` of the root `package.json`. A dependency that is only reachable through the tree is transitive by definition here, regardless of who maintains it.
