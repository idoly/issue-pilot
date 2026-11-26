function patch(name: string, version: string, buildOnly = false) {
  return { name, version, buildOnly, file: `${name.replace("/", "+")}+${version}.patch` };
}

// Explicit, not discovered from disk: an accidentally missing runtime patch must fail closed.
export const dependencyPatches = [patch("@earendil-works/pi-coding-agent", "1.6.1"), patch("zod", "4.6.7"), patch("monaco-editor", "0.58.0", true)];
