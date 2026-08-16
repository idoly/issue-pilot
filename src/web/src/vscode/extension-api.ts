import "vscode/localExtensionHost";

import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

export const sourceControlRefreshCommand = "issue-pilot.sourceControl.refresh";

const extension = registerExtension({
  name: "issue-pilot-workbench",
  publisher: "issue-pilot",
  version: "1.0.0",
  engines: { vscode: "*" },
  enabledApiProposals: ["scmHistoryProvider", "textSearchProvider"],
  contributes: {
    commands: [{ command: sourceControlRefreshCommand, title: "刷新只读变更", icon: "$(refresh)" }],
    menus: { "scm/title": [{ command: sourceControlRefreshCommand, group: "navigation" }] },
  },
}, ExtensionHostKind.LocalProcess, { system: true });

export type IssuePilotVscodeApi = Awaited<ReturnType<typeof extension.getApi>>;

export function getIssuePilotVscodeApi(): Promise<IssuePilotVscodeApi> {
  return extension.getApi();
}
