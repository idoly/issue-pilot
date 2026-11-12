# Configuration, Identity and Credentials

AI reference. [Index](README.md) · [Human configuration guide](../CONFIGURATION.md)

## Configuration layers

| Source | Authority | Application boundary |
| --- | --- | --- |
| [issue-pilot.config.ts](../../issue-pilot.config.ts) | State, listeners, time zone, bootstrap, hard budgets, parameter defaults | API restart; rebuild Web for values it imports |
| SQLite | Users, repositories, services/deployments, MCP, credentials, model selection, preferences, parameter overrides | Owning API transactions, reservations, revisions and hot-update rules |
| Runtime user's Pi directory | Model definitions, settings, instructions, skills, prompts, extensions | Session preparation; not a promise to refresh existing sessions |

[config.ts](../../src/config.ts) resolves state.directory from the source root and databaseFile from state root, independent of shell cwd. The current path is data/issues.db. There is no state/database environment override, business .env or user/service YAML projection. Never fill missing DB values from historical private files.

bootstrapUser inserts only into an empty user table; changing it does not rename existing users. Bootstrap synchronizes default environment names. SQLite remains authoritative; deployment model overrides and retired YAML import/export must not return.

Service, repository and user edits, personal credentials and shared DMS/SLS credential updates require a nonnegative safe-integer expectedRevision from their current read projection. Missing or invalid revisions return invalid_configuration_revision (400); stale revisions return configuration_changed (409), before writes or session disposal. Creation does not require a revision. Keep drafts on conflict and reread before merging; never omit the revision or pair an old draft with a newer revision to force a save. Owner: [input.ts](../../src/http/input.ts).

## Operator model catalog

Pi getAgentDir() defaults to ~/.pi/agent. SDK PI_CODING_AGENT_DIR changes resources, not application state. Verify the actual process user, HOME and permissions; another shell's configuration is not equivalent.

The [models.json example](../../examples/models.json) is a key-free template. Merge real providers, baseUrl, api, model IDs and capabilities into the user's models.json.providers. Do not overwrite unrelated definitions. The .invalid endpoint is unusable and omitted pricing is not a cost guarantee. The locked SDK's docs/models-configuration.md owns its full format.

This offline check does not call a model or mutate the business DB; its private temporary runtime is closed:

```bash
node --experimental-strip-types --input-type=module <<'NODE'
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { PiAgentModelCatalog } from './src/agent/model-runtime.ts';
const catalog = new PiAgentModelCatalog();
try {
  console.log('Pi directory:', getAgentDir());
  const models = await catalog.list();
  if (!models.length) throw new Error('global_agent_model_unavailable');
  console.log(models.map(({ provider, id }) => ({ provider, id })));
} finally {
  await catalog.close();
}
NODE
```

[model-runtime.ts](../../src/agent/model-runtime.ts) refreshes without network and lists providers defined by the Operator. Empty-DB initialization chooses the first provider/id-sorted model, prefers medium thinking, otherwise its first supported level, and starts Codemode on. It does not select the best model. Existing configuration is not automatically reselected after catalog changes. Owner: [agent.ts](../../src/configuration/agent.ts).

## Identity and permissions

[route-context.ts](../../src/http/route-context.ts) treats X-Issue-Pilot-Subject as a selector, not authentication. A trusted gateway must authenticate, overwrite incoming identity and prevent bypass. Some catalog/detail GETs have no identity check; there is no per-Issue ACL.

Without an explicit subject, select the first active user by createdAt/subject and pin it to the request. Reload authorization after relevant waits; deactivation never switches identity. developer and isAdmin are independent checks.

User mutations protect required active users, developers, administrators and at least one active developer with management access. UI visibility is not authorization. Owner: [user-routes.ts](../../src/http/user-routes.ts); regression: [mutation-identity.test.ts](../../tests/http/mutation-identity.test.ts).

## Credential owner and selection

Owner = assignee, else reporter, and must be active. Selection belongs to [user-credentials.ts](../../src/configuration/user-credentials.ts) and [credentials.ts](../../src/configuration/credentials.ts). Failed credentials never switch identity.

| Group | Selection/failure rule |
| --- | --- |
| Model | Any role's complete personal provider/model/thinking/Codemode/key replaces the shared group; otherwise shared. Missing/failed selected keys fail without fallback |
| Git | Developer's own SSH identity only; no Operator, ssh-agent, another user or shared fallback |
| DMS | Complete personal URL/Authorization in prod/test, else shared; incomplete personal group fails |
| SLS | Complete personal AK ID/Secret in prod/test, else shared; incomplete personal group fails |

Development evidence queries explicitly select prod/test. Credentials do not create targets. Shared model/runtime settings are global; deployments have no model override. Personal models replace selection and key, not the global runtime.

Operator auth.json/models.json keys and headers do not reach application model requests. Request runtimes isolate the SQLite-selected key and disable host credential fallback. Initialization/close failures retain cleanup ownership. Verify with [model-runtime.test.ts](../../tests/agent/model-runtime.test.ts).

Personal SSH uses -F /dev/null, IdentityAgent=none and BatchMode; SSH config aliases, ProxyJump and interactive passphrases are not used. Put non-default ports in the repository URL, e.g. ssh://git@git.example.test:2222/team/repo.git. The host user verifies known_hosts in advance; saving credentials is not a connectivity test. Owner: [git-credentials.ts](../../src/workspace/git-credentials.ts).

## Secret mutation and projection

- Ordinary configuration GET removes credentials. Developer-only selected descriptions/MCP editors expose only their documented fields; native DMS Authorization and SLS keys remain hidden.
- Connection secrets never enter prompts, tool input, argv, diagnostics or ordinary logs. Explicitly requested authorized business tokens from DMS/SLS may be returned with source/time; they do not expand query scope.
- Unchanged UI secrets are retained by omitting fields/requests. API empty strings do not mean retain. Clearing is explicit; replacement requires a complete group. Changed DMS URL requires Authorization again; changed model provider cannot retain another provider's key.
- Shared models live in global_agent_configuration, personal models in user_credentials, shared DMS/SLS in application_settings with separate revisions, not deployments.
- Credential/model writes reserve affected Issues and close old sessions; active work conflicts. Parameter updates use a different path and must not become a global session rebuild.

Owners: [user-routes.ts](../../src/http/user-routes.ts), [configuration-routes.ts](../../src/http/configuration-routes.ts), [read.ts](../../src/configuration/read.ts).

## Runtime parameters

GET /api/config/parameters returns revision, overrides, values, defaults and bounds. Admin GET with ?include=issueSearch and admin PUT also return the projected issueSearch configuration. Admin PUT takes { expectedRevision, overrides, issueSearch? }. Overrides is a complete snapshot: omitted fields use root defaults; {} clears all overrides. Do not submit a one-field patch as the whole snapshot. An included issueSearch update uses its [own revision and credential rules](HTTP.md#issue-vector-search); both updates commit in one SQLite transaction. A stale revision yields configuration_changed. Unchanged parameter overrides do not reset runtime budgets or the maintenance timer.

Root defaults below are not the installation's effective values:

| Parameter | Default | Effect |
| --- | --- | --- |
| maxConcurrentIssues | 10 | New execution slots; lowering does not cancel existing work |
| modelResponseIdleMs | 300 seconds | Continuous model inactivity; paused during tools |
| workspaceRetentionMs | 7 days | From resolvedAt, followed by safety checks |
| workspaceHighWaterBytes / workspaceTargetBytes | 20 / 16 GiB | Issue-root capacity trigger, excluding shared Git; not a disk quota |
| workspaceMaintenanceIntervalMs | 15 minutes | Delay from listen or from the end of the last pass; zero disables automatic passes |
| capabilityConnectionMs | 10 seconds | Future SLS CLI connect timeout, rounded up to seconds |
| mcpExecutionMs | 120 seconds | Each new MCP tool/resource request |
| dmsExecutionMs / slsExecutionMs | 120 / 30 seconds | New native queries |
| dingtalkAttachmentHosts | Root host list | Subsequent imports |
| networkMode / networkAllowedDomains | open / root list | New proxy connections; existing connections remain |

[parameters.ts](../../src/configuration/parameters.ts) validates bounds: concurrency 1–64, retention one hour–365 days, nonzero maintenance at least one minute, nonzero high water greater than target, lists at most 100 with no duplicates. API units are integer milliseconds/bytes; display conversion must not round unchanged fields.

Persist first, then replace the process snapshot. Update the Engine limit, workspace policy or sandbox allowlist only when its effective values change. The sandbox reads network mode from the snapshot on each decision. An unrelated edit does not invalidate workspace measurements. Do not reserve every Issue, close every session or replay in-flight requests. MCP budgets use the [SDK getter patch](../../patches/README.md#service-mcp-request-budgets). Ports, state, time zone and hard budgets are not hot parameters. Regression: [application-parameters.test.ts](../../tests/http/application-parameters.test.ts).

## Issue network access

open allows outbound operations supported by the existing proxy; it does not distinguish remote reads from writes. allowlist uses the parameter base list plus global Agent runtime additions. Entries may include ports; no port matches any port. Bare * is rejected. Switching mode retains the list.

Each new request/CONNECT reads current policy; existing tunnels are not terminated. Explicit SRT allow/deny rules precede automatic open grants. Automatic grants exclude non-explicit local, loopback, link-local and cloud metadata targets; application-port restrictions remain. DNS/upstream proxies independently affect routing, so local checks are not a remote-resolution guarantee.

This setting does not provision a browser, site login or general UDP/ICMP capability, and never relaxes filesystem isolation. Owner: [issue-sandbox.ts](../../src/agent/issue-sandbox.ts). Failed hot synchronization retries on later sandbox acquisition, not by replaying business operations.

## Services and query targets

The repository catalog owns URL, name and independent group. Services bind repositories; prod/test deployments own baselines and targets. Dev baselines derive from the same service's prod deployment. Recorded Issue paths/branches remain historical and cannot be guessed from changed configuration.

Service writes require an explicit deployments array; omission is not clearing. Keep drafts on revision conflict. Repository URL cascades advance service revisions; group-only edits do not rebind Issues. Owner: [service-configuration.ts](../../src/http/service-configuration.ts).

- DMS records instanceAlias/schema intent; the server resolves actual instances/databaseId using the selected credentials, not client-supplied host/ID guesses.
- SLS records region/project/logstores or multiple targets. A configured * still requires a concrete logstore at call time; there is no custom target name.
- Actual deployment targets determine native availability. Do not hard-code environment exclusions. Retired NACOS/DB/Redis/MQ/ES settings remain private historical state and neither execute nor project publicly.
- DBHub is deployment-owned stdio MCP. Deployment targets are its sole persisted configuration; launch connections are derived on read, including current executable/package paths. Migration 0075 removes the old generated connection shape without changing targets or explicit MCP records. Generated and explicit connection IDs/names must remain unique, with conflicting writes rolled back. Types belong to domain/contracts.ts. DSNs travel only in environment variables, not argv; read-only/row/timeout hints do not replace a read-only remote account. Generated connections cannot be arbitrarily mutated by generic MCP APIs.

See [dbhub.ts](../../src/configuration/dbhub.ts), [dbhub.toml](../../scripts/dbhub.toml), [service-context.ts](../../src/configuration/service-context.ts). Blocked optional-driver installation is not proof that every database type works.

## Service MCP and DingTalk

Service MCP supports HTTPS Streamable HTTP, SSE and stdio. Connections require deployment ownership, allowed environment and Issue entry/included service scope. Global connections without deployment_id are not Agent tools. Default/user-preference DingTalk import connections are application-only. Pi owns discovery, connections and shutdown.

Global connection management, private reads and testing are admin-only. Discovery and close must both succeed for a successful test. Read-only hints are descriptive, not authorization; preserve budgets, cancellation and input/result checks.

DingTalk preferences hold only source and field mappings; personal values override shared values, not gateway credentials. The optional reporterNote mapping defaults to a unique 提出人备注 column; nonempty text is appended to the description of a newly created Issue and counts toward the import description limit. Import deduplicates exact source records first. A valid new record may match a manual same-title or external-number Issue only in the requested service and work mode environment. Multiple matching manual Issues return dingtalk_manual_match_ambiguous (409) without choosing one. An invalid service/work mode target cannot succeed through manual matching.

Attachments require allowed HTTPS hosts, no redirects and no forwarded MCP key. Stream/staging cleanup failures must not become ordinary cancellation. Start defaults are documented in [Protocols](HTTP.md#dingtalk-import). Owners: [dingtalk-routes.ts](../../src/http/dingtalk-routes.ts), [dingtalk-attachments.ts](../../src/http/dingtalk-attachments.ts).

## Pi resources

Use the runtime user's Pi resources, not application-private skills/extensions or Issue-local extensions. Resource inspection discovers without executing extensions. Operator extensions cannot override protected application tools.

Pi settings are the baseline; SQLite runtime.settings overrides only domain/contracts.ts allowlisted fields, with omission restoring baseline. Network additions belong to global runtime. See [Agent](AGENT.md) for session lifecycle and execution boundaries.
