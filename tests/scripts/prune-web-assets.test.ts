import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const prune = (root: string, ...options: string[]) => execute(process.execPath, ["--experimental-strip-types", "scripts/prune-web-assets.ts", root, ...options]);

async function generation(root: string, suffix: string, id: string): Promise<void> {
  const files = [`index-${id}AAAAA.js`, `index-${id}BBBBB.css`, `Lazy-${id}CCCCC.js`, `editor.worker-${id}DDDDD.js`, `Geist-${id}EEEEE.woff2`];
  for (const file of files) await writeFile(path.join(root, "assets", file), file);
  await writeFile(path.join(root, "assets", `${files[0]}.br`), "br");
  await writeFile(path.join(root, "assets", `${files[2]}.gz`), "gz");
  const manifest = {
    "index.html": { file: `assets/${files[0]}`, css: [`assets/${files[1]}`], assets: [`assets/${files[4]}`], dynamicImports: ["src/Lazy.tsx"] },
    "src/Lazy.tsx": { file: `assets/${files[2]}`, isDynamicEntry: true },
    "monaco/editor.worker.js": { file: `assets/${files[3]}` },
  };
  await writeFile(path.join(root, ".vite", `manifest${suffix}.json`), JSON.stringify(manifest));
  await writeFile(
    path.join(root, suffix ? "index.previous.html" : "index.html"),
    `<link rel="icon" href="/assets/app-icon.svg"><script type="module" crossorigin src="/assets/${files[0]}"></script><link rel="stylesheet" crossorigin href="/assets/${files[1]}">`,
  );
}

test("prunes hashed Web assets outside the current and previous generations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-web-assets-"));
  try {
    await mkdir(path.join(root, ".vite"), { recursive: true });
    await mkdir(path.join(root, "assets", "editor-icons-5.40.0"), { recursive: true });
    await writeFile(path.join(root, "assets", "editor-icons-5.40.0", "file-old-Hashlike1.svg"), "icon");
    for (const stable of ["app-icon.svg", "editor-icon-licenses.txt", "interface-licenses.txt"]) await writeFile(path.join(root, "assets", stable), stable);
    await generation(root, "", "new");
    await assert.rejects(prune(root), (error) => error instanceof Error && "stderr" in error && /web_manifest_unreadable:\.vite\/manifest\.previous\.json/.test(String(error.stderr)));

    await generation(root, ".previous", "mid");
    // An older generation and orphaned compressed siblings are the only removable files.
    for (const stale of ["index-oldAAAAA.js", "index-oldAAAAA.js.br", "index-oldAAAAA.js.gz", "Lazy-oldCCCCC.js", "Missing-oldZZZZZ.js.br"]) await writeFile(path.join(root, "assets", stale), stale);
    const before = (await readdir(path.join(root, "assets"))).sort();

    const dryRun = await prune(root);
    assert.match(dryRun.stdout, /^Would remove 5 files/);
    assert.deepEqual((await readdir(path.join(root, "assets"))).sort(), before);

    const applied = await prune(root, "--apply");
    const removed = applied.stdout.trim().split("\n").slice(1);
    assert.deepEqual(removed, ["assets/Lazy-oldCCCCC.js", "assets/Missing-oldZZZZZ.js.br", "assets/index-oldAAAAA.js", "assets/index-oldAAAAA.js.br", "assets/index-oldAAAAA.js.gz"]);
    const remaining = await readdir(path.join(root, "assets"));
    assert.deepEqual(
      remaining.sort(),
      before.filter((name) => !removed.includes(`assets/${name}`)),
    );
    for (const kept of ["app-icon.svg", "editor-icons-5.40.0", "index-newAAAAA.js.br", "Lazy-midCCCCC.js.gz", "editor.worker-midDDDDD.js", "Geist-newEEEEE.woff2"])
      assert.ok(remaining.includes(kept), kept);
    assert.deepEqual(await readdir(path.join(root, "assets", "editor-icons-5.40.0")), ["file-old-Hashlike1.svg"]);
    assert.match((await prune(root)).stdout, /^Would remove 0 files/);

    // A page paired with the wrong manifest, or a manifest file missing from the copy, refuses before deleting.
    await writeFile(path.join(root, "index.previous.html"), `<script type="module" src="/assets/index-oldAAAAA.js"></script>`);
    await assert.rejects(prune(root, "--apply"), (error) => error instanceof Error && "stderr" in error && /web_manifest_html_mismatch:index\.previous\.html/.test(String(error.stderr)));
    await generation(root, ".previous", "mid");
    await rm(path.join(root, "assets", "Lazy-newCCCCC.js"));
    await assert.rejects(
      prune(root, "--apply"),
      (error) => error instanceof Error && "stderr" in error && /web_manifest_file_missing:\.vite\/manifest\.json:assets\/Lazy-newCCCCC\.js/.test(String(error.stderr)),
    );
    assert.ok((await readdir(path.join(root, "assets"))).includes("index-midAAAAA.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
