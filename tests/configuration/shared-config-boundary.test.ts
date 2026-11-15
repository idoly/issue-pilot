import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { issuePilotConfig, sharedConfig } from "../../issue-pilot.config.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const importPattern = /(?:import|export)[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`].find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

test("modules reachable from the Web entry use only the browser-safe configuration projection", () => {
  const pending = [path.join(repositoryRoot, "src/web/src/main.tsx")];
  const seen = new Set<string>();
  const offenders: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (!file.endsWith("issue-pilot.config.ts") && /\bissuePilotConfig\b/.test(source)) offenders.push(path.relative(repositoryRoot, file));
    for (const match of source.matchAll(importPattern)) {
      const target = resolveRelative(file, match[1] ?? match[2]!);
      if (target && !/\.test\.tsx?$/.test(target)) pending.push(target);
    }
  }
  assert.ok(seen.size > 20, "the Web import graph was not traversed");
  assert.deepEqual(offenders, []);
});

test("the shared projection excludes server-only identities, network policy and paths", () => {
  assert.deepEqual(Object.keys(sharedConfig).sort(), ["defaults", "limits", "regional", "web"]);
  for (const key of Object.keys(sharedConfig) as Array<keyof typeof sharedConfig>) assert.equal(sharedConfig[key], issuePilotConfig[key]);
  assert.ok(Object.isFrozen(issuePilotConfig.parameters.networkAllowedDomains));
});
