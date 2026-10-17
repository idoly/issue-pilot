import "./workers";

import "@codingame/monaco-vscode-css-default-extension";
import "@codingame/monaco-vscode-docker-default-extension";
import "@codingame/monaco-vscode-dotenv-default-extension";
import "@codingame/monaco-vscode-html-default-extension";
import "@codingame/monaco-vscode-ini-default-extension";
import "@codingame/monaco-vscode-java-default-extension";
import "@codingame/monaco-vscode-javascript-default-extension";
import "@codingame/monaco-vscode-json-default-extension";
import "@codingame/monaco-vscode-less-default-extension";
import "@codingame/monaco-vscode-markdown-basics-default-extension";
import "@codingame/monaco-vscode-scss-default-extension";
import "@codingame/monaco-vscode-shellscript-default-extension";
import "@codingame/monaco-vscode-sql-default-extension";
import "@codingame/monaco-vscode-typescript-basics-default-extension";
import "@codingame/monaco-vscode-xml-default-extension";
import "@codingame/monaco-vscode-yaml-default-extension";
// TextMate extensions above own the project's primary languages. Only load
// a standalone fallback for Python scripts, rather than every Monaco language.
import "@codingame/monaco-vscode-standalone-languages/languages/definitions/python/register.js";
import "@codingame/monaco-vscode-standalone-typescript-language-features";
import "@codingame/monaco-vscode-standalone-json-language-features";
import "@codingame/monaco-vscode-standalone-css-language-features";
import "@codingame/monaco-vscode-standalone-html-language-features";
import "virtual:issue-pilot-github-dark-default";
import { whenReady as materialIconThemeReady } from "virtual:issue-pilot-material-icon-theme";

import { initialize, LogLevel } from "@codingame/monaco-vscode-api";
import getConfigurationServiceOverride, { initUserConfiguration } from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getFilesServiceOverride, { registerFileSystemOverlay } from "@codingame/monaco-vscode-files-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLifecycleServiceOverride from "@codingame/monaco-vscode-lifecycle-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getScmServiceOverride from "@codingame/monaco-vscode-scm-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getWorkbenchServiceOverride, { registerCustomView, ViewContainerLocation } from "@codingame/monaco-vscode-workbench-service-override";
import getWorkingCopyServiceOverride from "@codingame/monaco-vscode-working-copy-service-override";
import getWorkspaceTrustServiceOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
import { getService, IWorkbenchLayoutService } from "@codingame/monaco-vscode-api";
import { IEditorService, IStatusbarService, IViewsService } from "@codingame/monaco-vscode-api/services";
import { Action, ActionRunner } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import { IContextMenuService, IContextViewService } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { IDialogService } from "@codingame/monaco-vscode-api/vscode/vs/platform/dialogs/common/dialogs.service";
import { Parts } from "@codingame/monaco-vscode-workbench-service-override";
import * as monaco from "monaco-editor";
import { parseIssueKey } from "../../../domain/contracts";
import { loadSourceRepositories } from "../data/client";
import { getIssuePilotVscodeApi, sourceControlDiscardCommand, sourceControlOpenChangesCommand, sourceControlOpenFileCommand, sourceControlOpenHeadCommand, sourceControlStageCommand, sourceControlUnstageCommand, type IssuePilotVscodeApi } from "./extension-api";
import { registerMarkdownPreview, registerMarkdownPreviewAction, registerMarkdownPreviewCommands } from "./markdown-preview";
import { registerSourceControls } from "./source-control";
import { SourceFileSystemProvider } from "./source-file-system";
import { getBudgetedSearchServiceOverride } from "./search-service";
import { registerSourceSearch } from "./source-search";
import "./workbench.css";

const agentViewClass = "issue-pilot-agent-view";
const detailsViewClass = "issue-pilot-details-view";

function workbenchTheme(container: HTMLElement) {
  const workbench = container.matches(".monaco-workbench") ? container : container.querySelector<HTMLElement>(".monaco-workbench");
  const style = getComputedStyle(workbench ?? container);
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--vscode-sideBar-background", "#010409"),
    foreground: color("--vscode-sideBar-foreground", "#e6edf3"),
    mutedForeground: color("--vscode-descriptionForeground", "#8b949e"),
    border: color("--vscode-sideBar-border", color("--vscode-panel-border", "#30363d")),
    inputBackground: color("--vscode-input-background", "#0d1117"),
    inputForeground: color("--vscode-input-foreground", "#e6edf3"),
    inputBorder: color("--vscode-input-border", "#30363d"),
    focusBorder: color("--vscode-focusBorder", "#58a6ff"),
    buttonBackground: color("--vscode-button-background", "#238636"),
    buttonForeground: color("--vscode-button-foreground", "#fff"),
    buttonHoverBackground: color("--vscode-button-hoverBackground", "#2ea043"),
    hoverBackground: color("--vscode-list-hoverBackground", "#21262d"),
  };
}

function registerEmbeddedViews(): void {
  const register = (id: string, name: string, location: ViewContainerLocation, className: string) => registerCustomView({
    id,
    name,
    location,
    default: true,
    canMoveView: false,
    canToggleVisibility: false,
    renderBody(container) {
      container.classList.add("issue-pilot-embedded-view", className);
      return { dispose() {} };
    },
  });
  register("issue-pilot.agent", "Agent", ViewContainerLocation.Panel, agentViewClass);
  register("issue-pilot.details", "工单详情", ViewContainerLocation.AuxiliaryBar, detailsViewClass);
}

function limitContextMenus(
  container: HTMLElement,
  vscode: Awaited<ReturnType<typeof getIssuePilotVscodeApi>>,
  contextMenuService: IContextMenuService,
  contextViewService: IContextViewService,
): void {
  const actionRunner = new ActionRunner();
  let selectedResourceUri: import("vscode").Uri | undefined;
  container.addEventListener("contextmenu", (event) => {
    const eventTarget = event.target;
    const row = eventTarget instanceof Element ? eventTarget.closest<HTMLElement>(".monaco-list-row") : null;
    const resource = eventTarget instanceof Element ? eventTarget.closest<HTMLElement>(".resource, .resource-group, .history-item-change") ?? row?.querySelector<HTMLElement>(".resource, .resource-group, .history-item-change") ?? null : null;
    if (!resource || !row) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (resource.classList.contains("resource-group")) {
      selectedResourceUri = undefined;
      event.preventDefault();
      event.stopImmediatePropagation();
      const count = Number(resource.querySelector<HTMLElement>(".monaco-count-badge")?.textContent ?? "0");
      const actions = [...row.querySelectorAll<HTMLElement>(".actions [aria-label]")].map((element) => {
        const label = element.getAttribute("aria-label")!;
        return new Action(`issue-pilot.resource-group.${label}`, label, undefined, count > 0, () => element.click());
      });
      contextMenuService.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY }), getActions: () => actions, actionRunner });
      return;
    }
    const path = row.querySelector<HTMLElement>(".monaco-icon-label.file-icon")?.getAttribute("aria-label");
    if (!path?.startsWith("~/")) return;
    const resourceUri = vscode.Uri.file(path.slice(1));
    selectedResourceUri = resourceUri;
    const staged = Boolean(row.querySelector("[aria-label='Unstage Changes']"));
    event.preventDefault();
    event.stopImmediatePropagation();
    const commands = [
      ["Open Changes", sourceControlOpenChangesCommand],
      ["Open File", sourceControlOpenFileCommand],
      ["Open File (HEAD)", sourceControlOpenHeadCommand],
      [staged ? "Unstage Changes" : "Stage Changes", staged ? sourceControlUnstageCommand : sourceControlStageCommand],
      ...staged ? [] : [["Discard Changes", sourceControlDiscardCommand]],
    ] as Array<[string, string]>;
    const actions = commands.map(([label, command]) => new Action(`issue-pilot.resource.${command}`, label, undefined, true, () => {
      queueMicrotask(() => { void vscode.commands.executeCommand(command, resourceUri); });
    }));
    contextMenuService.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY }), getActions: () => actions, actionRunner });
  }, true);
  container.ownerDocument.addEventListener("click", (event) => {
    const target = event.target;
    const label = target instanceof Element ? target.closest<HTMLElement>(".action-menu-item")?.querySelector<HTMLElement>(".action-label")?.getAttribute("aria-label") : undefined;
    const command = label ? new Map([
      ["Open Changes", sourceControlOpenChangesCommand],
      ["Open File", sourceControlOpenFileCommand],
      ["Open File (HEAD)", sourceControlOpenHeadCommand],
      ["Stage Changes", sourceControlStageCommand],
      ["Unstage Changes", sourceControlUnstageCommand],
      ["Discard Changes", sourceControlDiscardCommand],
    ]).get(label) : undefined;
    if (!command || !selectedResourceUri) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const resourceUri = selectedResourceUri;
    selectedResourceUri = undefined;
    contextViewService.hideContextView(false);
    queueMicrotask(() => { void vscode.commands.executeCommand(command, resourceUri); });
  }, true);
}

function observeWorkbenchParts(issueKey: string, container: HTMLElement, layout: IWorkbenchLayoutService): void {
  const observed = new Set<Element>();
  let viewsReady = false;
  const publish = () => {
    const agentView = container.querySelector<HTMLElement>(`.${agentViewClass}`);
    const detailsView = container.querySelector<HTMLElement>(`.${detailsViewClass}`);
    if (agentView && (container.clientWidth < 700 || detailsView)) viewsReady = true;
    if (!viewsReady) return;
    const root = container.getBoundingClientRect();
    const viewRect = (element: HTMLElement | null) => {
      const rect = element?.getBoundingClientRect();
      return rect ? {
        x: Math.max(0, rect.left - root.left),
        y: Math.max(0, rect.top - root.top),
        width: Math.max(0, rect.width),
        height: Math.max(0, rect.height),
      } : { x: 0, y: 0, width: 0, height: 0 };
    };
    window.parent.postMessage({
      kind: "issue-pilot-workbench-layout",
      issueKey,
      panel: viewRect(agentView),
      auxiliary: viewRect(detailsView),
      panelVisible: layout.isVisible(Parts.PANEL_PART),
      auxiliaryVisible: layout.isVisible(Parts.AUXILIARYBAR_PART),
      theme: workbenchTheme(container),
    }, window.location.origin);
  };
  const observer = new ResizeObserver(publish);
  const observeViews = () => {
    for (const element of [container, ...container.querySelectorAll(`.${agentViewClass}, .${detailsViewClass}`)]) {
      if (observed.has(element)) continue;
      observed.add(element);
      observer.observe(element);
    }
    publish();
  };
  const mutationObserver = new MutationObserver(observeViews);
  mutationObserver.observe(container, { childList: true, subtree: true });
  layout.onDidChangePartVisibility(publish);
  window.addEventListener("resize", publish);
  observeViews();
}

function registerWorkbenchBridge(issueKey: string, vscode: IssuePilotVscodeApi, layout: IWorkbenchLayoutService, container: HTMLElement): void {
  const commands = {
    explorer: "workbench.view.explorer",
    search: "workbench.view.search",
    "source-control": "workbench.view.scm",
  } as const;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const message = event.data as { kind?: unknown; issueKey?: unknown; view?: unknown; visible?: unknown; panelOpen?: unknown; auxiliaryOpen?: unknown } | null;
    if (message?.issueKey !== issueKey) return;
    if (message.kind === "issue-pilot-workbench-view" && typeof message.view === "string" && message.view in commands && typeof message.visible === "boolean") {
      layout.setPartHidden(!message.visible, Parts.SIDEBAR_PART);
      if (message.visible) void vscode.commands.executeCommand(commands[message.view as keyof typeof commands]);
      return;
    }
    if (message.kind !== "issue-pilot-workbench-parts" || typeof message.panelOpen !== "boolean" || typeof message.auxiliaryOpen !== "boolean") return;
    layout.setPartHidden(!message.panelOpen, Parts.PANEL_PART);
    layout.setPartHidden(!message.auxiliaryOpen || container.clientWidth < 700, Parts.AUXILIARYBAR_PART);
  });
}

function reportStartup(kind: "issue-pilot-workbench-ready" | "issue-pilot-workbench-error", issueKey: string): void {
  window.parent.postMessage({ kind, issueKey }, window.location.origin);
}

function renderError(message: string): void {
  const root = document.querySelector<HTMLElement>("#vscode-workbench");
  if (!root) return;
  root.className = "vscode-workbench-error";
  root.setAttribute("role", "alert");
  root.textContent = `代码工作台加载失败：${message}`;
}

async function start(): Promise<void> {
  const parameters = new URL(window.location.href).searchParams;
  const issueKey = parseIssueKey(parameters.get("issue") ?? "");
  const initialView = parameters.get("view") === "source-control" ? "source-control" : "explorer";
  if (!issueKey) throw new Error("invalid_issue_key");
  const repositories = await loadSourceRepositories(issueKey);
  if (!repositories.length) throw new Error("source_repository_not_found");

  const provider = new SourceFileSystemProvider(issueKey, repositories);
  registerMarkdownPreview();
  registerEmbeddedViews();
  registerFileSystemOverlay(100, provider);
  await initUserConfiguration(JSON.stringify({
    "workbench.colorTheme": "GitHub Dark Default",
    "workbench.iconTheme": "material-icon-theme",
    "workbench.activity.showAccounts": false,
    "workbench.activityBar.location": "default",
    "workbench.layoutControl.enabled": false,
    "workbench.secondarySideBar.defaultVisibility": "visible",
    "workbench.editor.editorActionsLocation": "default",
    "workbench.editorLargeFileConfirmation": Number.MAX_SAFE_INTEGER,
    "diffEditor.maxFileSize": 0,
    "window.commandCenter": false,
  }));
  const container = document.querySelector<HTMLElement>("#vscode-workbench");
  if (!container) throw new Error("workbench_container_missing");

  await initialize({
    ...getLogServiceOverride(),
    ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
    ...getFilesServiceOverride(),
    ...getConfigurationServiceOverride(),
    ...getDialogsServiceOverride(),
    ...getStorageServiceOverride(),
    ...getLifecycleServiceOverride(),
    ...getEnvironmentServiceOverride(),
    ...getWorkspaceTrustServiceOverride(),
    ...getWorkingCopyServiceOverride(),
    ...getModelServiceOverride(),
    ...getLanguagesServiceOverride(),
    ...getBudgetedSearchServiceOverride(),
    ...getScmServiceOverride(),
    ...getTextmateServiceOverride(),
    ...getThemeServiceOverride(),
    ...getExplorerServiceOverride(),
    ...getWorkbenchServiceOverride(),
    ...getQuickAccessServiceOverride({
      isKeybindingConfigurationVisible: () => false,
      shouldUseGlobalPicker: () => true,
    }),
  }, container, {
    workspaceProvider: {
      trusted: true,
      async open() { return false; },
      workspace: { workspaceUri: monaco.Uri.file(provider.workspaceUriPath) },
    },
    enableWorkspaceTrust: false,
    developmentOptions: { logLevel: LogLevel.Warning },
    configurationDefaults: {
      "window.title": `${issueKey} - Issue Pilot`,
      "window.commandCenter": false,
      "window.menuBarVisibility": "hidden",
      "workbench.activityBar.location": "default",
      "workbench.activity.showAccounts": false,
      "workbench.startupEditor": "none",
      "workbench.editorLargeFileConfirmation": Number.MAX_SAFE_INTEGER,
      "workbench.statusBar.visible": true,
      "diffEditor.maxFileSize": 0,
      "workbench.view.alwaysShowHeaderActions": true,
      "security.workspace.trust.enabled": false,
      "scm.repositories.selectionMode": "single",
      "editor.dropIntoEditor.enabled": false,
      "editor.minimap.enabled": true,
      "editor.stickyScroll.enabled": true,
      "editor.scrollBeyondLastLine": false,
      "markdown.editor.drop.enabled": "never",
      "markdown.editor.filePaste.enabled": "never",
      "markdown.updateLinksOnFileMove.enabled": "never",
    },
    defaultLayout: {
      views: [{ id: "workbench.explorer.fileView" }],
      force: true,
    },
    productConfiguration: {
      nameShort: "Issue Pilot",
      nameLong: "Issue Pilot代码工作台",
    },
  }, { userHome: monaco.Uri.file("/") });

  const [layout, editorService, statusbarService, contextMenuService, contextViewService, dialogService, viewsService, vscode] = await Promise.all([getService(IWorkbenchLayoutService), getService(IEditorService), getService(IStatusbarService), getService(IContextMenuService), getService(IContextViewService), getService(IDialogService), getService(IViewsService), getIssuePilotVscodeApi()]);
  registerWorkbenchBridge(issueKey, vscode, layout, container);
  registerMarkdownPreviewAction(container);
  layout.setPartHidden(true, Parts.TITLEBAR_PART);
  layout.setPartHidden(true, Parts.ACTIVITYBAR_PART);
  await vscode.commands.executeCommand("workbench.action.positionPanelBottom");
  layout.setPanelAlignment("center");
  const auxiliaryVisible = container.clientWidth >= 700;
  layout.setPartHidden(false, Parts.PANEL_PART);
  layout.setPartHidden(!auxiliaryVisible, Parts.AUXILIARYBAR_PART);
  const panelSize = layout.getSize(Parts.PANEL_PART);
  layout.resizePart(Parts.PANEL_PART, 0, Math.max(220, Math.round(container.clientHeight * 0.36)) - panelSize.height);
  if (auxiliaryVisible) {
    const auxiliarySize = layout.getSize(Parts.AUXILIARYBAR_PART);
    layout.resizePart(Parts.AUXILIARYBAR_PART, Math.max(280, Math.min(380, Math.round(container.clientWidth * 0.24))) - auxiliarySize.width, 0);
  }
  const [, , refreshSourceControls] = await Promise.all([
    materialIconThemeReady(),
    registerSourceSearch(issueKey, repositories),
    registerSourceControls(issueKey, repositories, provider.workspacePath, editorService, async (label) => (await dialogService.confirm({
      type: "warning",
      message: `Discard changes in ${label}?`,
      detail: "This action cannot be undone.",
      primaryButton: "&&Discard Changes",
    })).confirmed),
  ]);
  let refreshGeneration = 0;
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as { kind?: unknown; issueKey?: unknown } | null;
    if (event.origin !== window.location.origin || event.source !== window.parent || message?.issueKey !== issueKey || message.kind !== "issue-pilot-workbench-repositories") return;
    const generation = ++refreshGeneration;
    void loadSourceRepositories(issueKey).then(async (next) => {
      if (generation !== refreshGeneration) return;
      repositories.splice(0, repositories.length, ...next);
      provider.updateRepositories(next);
      await refreshSourceControls();
    }).catch(() => { console.warn("source_repository_refresh_failed"); });
  });
  limitContextMenus(container, vscode, contextMenuService, contextViewService);
  provider.setOnWrite(() => { void refreshSourceControls(); });
  await viewsService.openView("workbench.scm.repositories", false);
  if (initialView === "source-control") await vscode.commands.executeCommand("workbench.view.scm");
  await registerMarkdownPreviewCommands(container);
  layout.setPartHidden(true, Parts.TITLEBAR_PART);
  layout.setPartHidden(true, Parts.ACTIVITYBAR_PART);
  statusbarService.updateEntryVisibility("status.workbench.keyboardLayout", false);
  observeWorkbenchParts(issueKey, container, layout);
  reportStartup("issue-pilot-workbench-ready", issueKey);
}

void start().catch((error) => {
  renderError(error instanceof Error ? error.message : String(error));
  reportStartup("issue-pilot-workbench-error", new URL(window.location.href).searchParams.get("issue") ?? "");
});
