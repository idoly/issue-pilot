import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const prune = (root: string, ...options: string[]) => execute(process.execPath, ["scripts/prune-web-assets.ts", root, ...options]);

async function generation(root: string, suffix: string, id: string): Promise<void> {
  const files = [`index-${id}AAAAA.js`, `index-${id}BBBBB.css`, `Lazy-${id}CCCCC.js`, `editor.worker-${id}DDDDD.js`, `Geist-${id}EEEEE.woff2`];
  for (const file of files) await writeFile(path.join(root, "assets", file), file);
  await writeFile(path.join(root, "assets", `${files[0]}.br`), "br");
  await writeFile(path.join(root, "assets", `${files[2]}.gz`), "gz");
  await writeFile(path.join(root, "assets/shared-HASH1234.js"), "shared");
  const manifest = {
    shared: { file: "assets/shared-HASH1234.js" },
    "index.html": { file: `assets/${files[0]}`, imports: ["shared"], css: [`assets/${files[1]}`], assets: [`assets/${files[4]}`], dynamicImports: ["src/Lazy.tsx"] },
    "src/Lazy.tsx": { file: `assets/${files[2]}`, isDynamicEntry: true },
    "monaco/editor.worker.js": { file: `assets/${files[3]}` },
  };
  await writeFile(path.join(root, ".vite", `manifest${suffix}.json`), JSON.stringify(manifest));
  await writeFile(
    path.join(root, suffix ? "index.previous.html" : "index.html"),
    `<link rel="icon" href="/assets/app-icon.svg"><script type="module" crossorigin src="/assets/${files[0]}"></script><link rel="stylesheet" crossorigin href="/assets/${files[1]}">`,
  );
}

test("prunes only retired Web outputs after validating the current build", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-web-assets-"));
  try {
    await mkdir(path.join(root, ".vite"), { recursive: true });
    await mkdir(path.join(root, "assets", "editor-icons-5.40.0"), { recursive: true });
    await writeFile(path.join(root, "assets", "editor-icons-5.40.0", "file-old-Hashlike1.svg"), "icon");
    for (const stable of ["app-icon.svg", "editor-icon-licenses.txt", "interface-licenses.txt"]) await writeFile(path.join(root, "assets", stable), stable);
    await generation(root, "", "new");
    await prune(root, "--check-current");
    const html = path.join(root, "index.html");
    await writeFile(html, '<script type="module" src="/assets/index-otherXYZ.js"></script>');
    await assert.rejects(prune(root, "--check-current"), /web_manifest_html_mismatch:index\.html/);
    await writeFile(html, '<link rel="icon" href="/assets/missing.svg">');
    await assert.rejects(prune(root, "--check-current"), /web_html_file_missing:index\.html/);
    await generation(root, "", "new");
    assert.match((await prune(root)).stdout, /^Would remove 0 files/);
    const currentAssets = (await readdir(path.join(root, "assets"))).sort();

    await generation(root, ".previous", "mid");
    // Upgrading a two-generation deployment does not trust the retired manifest as a deletion list.
    await writeFile(path.join(root, ".vite/manifest.previous.json"), "retired");
    for (const stale of ["index-oldAAAAA.js", "index-oldAAAAA.js.br", "index-oldAAAAA.js.gz", "Lazy-oldCCCCC.js", "Missing-oldZZZZZ.js.br"]) await writeFile(path.join(root, "assets", stale), stale);
    const before = (await readdir(path.join(root, "assets"))).sort();

    const dryRun = await prune(root);
    assert.match(dryRun.stdout, /^Would remove 14 files/);
    assert.deepEqual((await readdir(path.join(root, "assets"))).sort(), before);

    const applied = await prune(root, "--apply");
    const removed = applied.stdout.trim().split("\n").slice(1);
    assert.deepEqual(removed, dryRun.stdout.trim().split("\n").slice(1));
    assert.deepEqual((await readdir(path.join(root, "assets"))).sort(), currentAssets);
    assert.deepEqual((await readdir(root)).sort(), [".vite", "assets", "index.html"]);
    assert.deepEqual(await readdir(path.join(root, ".vite")), ["manifest.json"]);
    assert.deepEqual(await readdir(path.join(root, "assets", "editor-icons-5.40.0")), ["file-old-Hashlike1.svg"]);
    assert.match((await prune(root)).stdout, /^Would remove 0 files/);

    // A page paired with the wrong manifest, or a manifest file missing from the copy, refuses before deleting.
    await generation(root, ".previous", "mid");
    await writeFile(html, `<script type="module" src="/assets/index-oldAAAAA.js"></script>`);
    await assert.rejects(prune(root, "--apply"), /web_manifest_html_mismatch:index\.html/);
    await writeFile(html, "<html></html>");
    await assert.rejects(prune(root, "--apply"), /web_html_entry_missing/);
    await generation(root, "", "new");
    await rm(path.join(root, "assets", "Lazy-newCCCCC.js"));
    await assert.rejects(
      prune(root, "--apply"),
      (error) => error instanceof Error && "stderr" in error && /web_manifest_file_missing:\.vite\/manifest\.json:assets\/Lazy-newCCCCC\.js/.test(String(error.stderr)),
    );
    assert.ok((await readdir(path.join(root, "assets"))).includes("index-midAAAAA.js"));

    await generation(root, "", "new");
    const manifestFile = path.join(root, ".vite/manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    delete manifest["src/Lazy.tsx"];
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(prune(root, "--apply"), /web_manifest_chunk_missing:src\/Lazy\.tsx/);
    await generation(root, "", "new");
    const previousPage = path.join(root, "index.previous.html");
    await rm(previousPage);
    await symlink(html, previousPage);
    await assert.rejects(prune(root, "--apply"), /web_expected_regular_file:index\.previous\.html/);
    assert.equal(await readFile(path.join(root, "assets/index-midAAAAA.js"), "utf8"), "index-midAAAAA.js");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
