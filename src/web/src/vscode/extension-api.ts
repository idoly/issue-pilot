import "vscode/localExtensionHost";

import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

export const sourceControlRefreshCommand = "issue-pilot.sourceControl.refresh";
export const sourceControlOpenChangesCommand = "issue-pilot.sourceControl.openChanges";
export const sourceControlOpenFileCommand = "issue-pilot.sourceControl.openFile";
export const sourceControlOpenHeadCommand = "issue-pilot.sourceControl.openHead";
export const sourceControlStageCommand = "issue-pilot.sourceControl.stage";
export const sourceControlUnstageCommand = "issue-pilot.sourceControl.unstage";
export const sourceControlDiscardCommand = "issue-pilot.sourceControl.discard";
export const sourceControlCommitCommand = "issue-pilot.sourceControl.commit";

const extension = registerExtension({
  name: "issue-pilot-workbench",
  publisher: "issue-pilot",
  version: "1.0.0",
  engines: { vscode: "*" },
  enabledApiProposals: ["scmActionButton", "scmHistoryProvider", "textSearchProvider"],
  contributes: {
    commands: [
      { command: sourceControlRefreshCommand, title: "刷新变更", icon: "$(refresh)" },
      { command: sourceControlOpenChangesCommand, title: "Open Changes" },
      { command: sourceControlOpenFileCommand, title: "Open File" },
      { command: sourceControlOpenHeadCommand, title: "Open File (HEAD)" },
      { command: sourceControlStageCommand, title: "Stage Changes", icon: "$(add)" },
      { command: sourceControlUnstageCommand, title: "Unstage Changes", icon: "$(remove)" },
      { command: sourceControlDiscardCommand, title: "Discard Changes", icon: "$(discard)" },
      { command: sourceControlCommitCommand, title: "Commit", icon: "$(check)" },
    ],
    menus: {
      "scm/title": [{ command: sourceControlRefreshCommand, group: "navigation" }],
      "scm/resourceGroup/context": [
        { command: sourceControlStageCommand, when: "scmResourceGroupState == issue-pilot-working", group: "inline@1" },
        { command: sourceControlUnstageCommand, when: "scmResourceGroupState == issue-pilot-staged", group: "inline@1" },
        { command: sourceControlDiscardCommand, when: "scmResourceGroupState == issue-pilot-working", group: "2_git@2" },
      ],
      "scm/resourceState/context": [
        { command: sourceControlOpenChangesCommand, when: "scmResourceState =~ /^issue-pilot-/", group: "1_open@1" },
        { command: sourceControlOpenFileCommand, when: "scmResourceState =~ /^issue-pilot-/ && scmResourceState != issue-pilot-working-deleted && scmResourceState != issue-pilot-staged-deleted", group: "1_open@2" },
        { command: sourceControlOpenHeadCommand, when: "scmResourceState =~ /^issue-pilot-/ && scmResourceState != issue-pilot-working-added && scmResourceState != issue-pilot-staged-added", group: "1_open@3" },
        { command: sourceControlStageCommand, when: "scmResourceState =~ /^issue-pilot-working-/", group: "inline@1" },
        { command: sourceControlDiscardCommand, when: "scmResourceState =~ /^issue-pilot-working-/", group: "inline@2" },
        { command: sourceControlUnstageCommand, when: "scmResourceState =~ /^issue-pilot-staged-/", group: "inline@1" },
        { command: sourceControlStageCommand, when: "scmResourceState =~ /^issue-pilot-working-/", group: "2_git@1" },
        { command: sourceControlUnstageCommand, when: "scmResourceState =~ /^issue-pilot-staged-/", group: "2_git@1" },
        { command: sourceControlDiscardCommand, when: "scmResourceState =~ /^issue-pilot-working-/", group: "2_git@2" },
      ],
    },
  },
}, ExtensionHostKind.LocalProcess, { system: true });

export type IssuePilotVscodeApi = Awaited<ReturnType<typeof extension.getApi>>;

export function getIssuePilotVscodeApi(): Promise<IssuePilotVscodeApi> {
  return extension.getApi();
}
