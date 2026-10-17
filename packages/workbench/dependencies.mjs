import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const manifestPath = new URL('./package.json', import.meta.url);
const rootPath = new URL('../../package.json', import.meta.url);
const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const aliases = {
  'monaco-editor': '@codingame/monaco-vscode-editor-api',
  vscode: '@codingame/monaco-vscode-extension-api',
};
const editorName = (name) => name.startsWith('@codingame/monaco-vscode-') || name in aliases;
const expectedRange = (name, version) => name in aliases ? `npm:${aliases[name]}@${version}` : version;

async function installed(name) {
  for (const directory of require.resolve.paths(name) ?? []) {
    try { return JSON.parse(await readFile(path.join(directory, name, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing ${name}; run npm ci from the repository root`);
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const root = JSON.parse(await readFile(rootPath, 'utf8'));
  const entries = Object.entries(manifest.devDependencies).filter(([name]) => editorName(name));
  const version = manifest.devDependencies['@codingame/monaco-vscode-api'];
  const args = process.argv.slice(2);
  if (args[0] === '--set' && args.length === 2) {
    const target = args[1];
    if (!/^\d+\.\d+\.\d+$/.test(target)) throw new Error('Use one exact release version, for example --set 37.6.0');
    // Preflight the entire release before modifying the manifest. Incomplete
    // upstream releases must never leave a partially upgraded dependency group.
    const failures = [];
    for (let offset = 0; offset < entries.length; offset += 8) {
      await Promise.all(entries.slice(offset, offset + 8).map(async ([name]) => {
        const actual = aliases[name] ?? name;
        try {
          const { stdout } = await exec('npm', ['view', `${actual}@${target}`, 'version', '--json'], { timeout: 20_000 });
          const result = JSON.parse(stdout);
          if (!(Array.isArray(result) ? result.includes(target) : result === target)) failures.push(actual);
        } catch { failures.push(actual); }
      }));
    }
    if (failures.length) throw new Error(`Release ${target} is unavailable or incomplete: ${failures.join(', ')}. Manifest unchanged.`);
    for (const [name] of entries) manifest.devDependencies[name] = expectedRange(name, target);
    const temporary = new URL(`./.package-${process.pid}.tmp`, import.meta.url);
    try { await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, manifestPath); }
    finally { await rm(temporary, { force: true }); }
    console.log(`Workbench dependencies set to ${target}. Run npm install, npm run typecheck, npm test, and npm run build from the repository root.`);
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === '--check')) throw new Error('Usage: npm run deps:editor -- --check | --set <version>');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Workbench core must use one exact version');
  for (const section of ['dependencies', 'devDependencies']) {
    const scattered = Object.keys(root[section] ?? {}).filter(editorName);
    if (scattered.length) throw new Error(`Move editor dependencies to packages/workbench/package.json: ${scattered.join(', ')}`);
  }
  for (const [name, range] of entries) {
    if (range !== expectedRange(name, version)) throw new Error(`${name} must match core ${version}; found ${range}`);
    const resolved = await installed(name);
    if (resolved.version !== version || resolved.name !== (aliases[name] ?? name)) throw new Error(`${name} resolves to ${resolved.name}@${resolved.version}, expected ${aliases[name] ?? name}@${version}; run npm install`);
  }
  console.log(`Workbench: ${entries.length} editor packages aligned at ${version}; build-only dependencies are centralized.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
