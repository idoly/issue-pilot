# Dependency Patches

Maintenance reference. [Development](../docs/DEVELOPMENT.md) · [Agent contracts](../docs/ai/README.md)

The lockfile fixes package versions. [postinstall](../scripts/apply-pi-sdk-patch.mjs) checks versions and forward/reverse patch context using Git; drift fails rather than being ignored. Run npm ci with the patch files in an independent checkout. Source edits do not update live node_modules.

## Pi output persistence

Patch: [pi-coding-agent 1.5.1](@earendil-works+pi-coding-agent+1.5.1.patch).

Codemode/MCP extensions accept optional saveOutput(data, extension), including read_mcp_resource. The Issue work-file owner persists images, binary and truncated output through 0600 temporary files and atomic replacement. Without the callback, SDK behavior is unchanged.

This does not change tool schemas, discovery, transport, authorization or session format. Remove the corresponding patch when an equivalent supported upstream API exists; retain persistence/cancellation/failure tests.

## Service MCP request budgets

The same Pi patch reads timeoutMs through a getter instead of capturing it during tool registration. Application MCP configuration supplies a dynamic timeout. Each new request captures its budget; existing sessions can use updated mcpExecutionMs without reconnecting or replaying in-flight requests. Resource reading retains the SDK's dynamic path.

Pi still owns registration, connections, cancellation and shutdown. An outer AbortSignal alone cannot extend an old captured SDK timer. Verify [mcp-extension.test.ts](../tests/agent/mcp-extension.test.ts); reassess the getter chain on upgrades.

## Zod v3 collection limits

Patch: [zod 4.6.7](zod+4.6.7.patch).

Zod 4.6.7 fixes the v4 Classic/Mini paths for [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The local patch protects its exported v3 Array/Set ESM/CJS paths: reject raw collections exceeding existing maxima before traversing elements or running transformations/refinements.

Normal, asynchronous and unbounded schemas retain their behavior. No new business limit is introduced. SRT imports zod/v3, so one installed Zod version does not mean one schema implementation.

[zod-security.test.ts](../tests/agent/zod-security.test.ts) checks entry points, normal/oversized/async input, MCP retry and SRT configuration, patch idempotency, drift and installed hashes. Remove this patch when upstream v3 has equivalent protection.

## Monaco inline-diff copying

Patch: [monaco-editor 0.57.0](monaco-editor+0.57.0.patch).

Inline deleted-line copying uses the original model selection already available in the native copy event and writes event.clipboardData directly. This avoids recursive textarea/execCommand fallback on HTTP pages without Clipboard API and preserves CRLF. Without event clipboard data, upstream fallback remains.

The patch does not grant write access or change selection/menu behavior. Verify real copy behavior in [browser acceptance](../tests/browser/acceptance.mjs) and patch integrity in zod-security.test.ts. Monaco is a build dependency: if installed it must match/apply; production-only installations may omit it. Build Web artifacts from patched dependencies. Remove the patch after an equivalent upstream fix.

## Dependency constraints and upgrades

- Zod is fixed for MCP/DBHub v4 and SRT's exported v3 usage.
- DOMPurify override keeps Monaco and application sanitization on the selected application version.
- Do not reintroduce superseded transitive-dependency patches or falsify audit versions.
- Verify fresh install/postinstall, behavior/security tests, build, production audit and affected deployment health in independent local checkouts.
- Never reverse patches or install experimental dependencies in live node_modules. Update code, dependencies and artifacts as one authorized release.
