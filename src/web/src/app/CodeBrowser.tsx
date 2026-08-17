import { Button } from "@idoly/ant-design-solid";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";

import { Code2, File, GitBranch, PanelBottom, PanelRight, Search, X } from "../ui/icons";

export interface WorkbenchPartRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WorkbenchPartLayout {
  panel: WorkbenchPartRect;
  auxiliary: WorkbenchPartRect;
}


function validRect(value: unknown): value is WorkbenchPartRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Partial<WorkbenchPartRect>;
  return [rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item) && item >= 0);
}

type WorkbenchView = "explorer" | "search" | "source-control";
type WorkbenchBlameHover = { left: number; bottom: number; author: string; date: string | null; subject: string; commit: string | null; path: string; line: number };

function validBlameDetail(value: unknown): value is Omit<WorkbenchBlameHover, "left" | "bottom"> {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<WorkbenchBlameHover>;
  return typeof detail.author === "string" && (detail.date === null || typeof detail.date === "string") && typeof detail.subject === "string"
    && (detail.commit === null || typeof detail.commit === "string") && typeof detail.path === "string" && Number.isSafeInteger(detail.line) && detail.line! > 0;
}

export default function CodeBrowser(props: { issueKey: string; development: boolean; agentOpen: boolean; detailsOpen: boolean; onClose: () => void; onLayout: (layout: WorkbenchPartLayout) => void; onPartVisibility: (agentOpen: boolean, detailsOpen?: boolean) => void; onToggleAgent: () => void; onToggleDetails: () => void }) {
  const initialView: WorkbenchView = untrack(() => props.development) ? "source-control" : "explorer";
  const workbenchUrl = () => `/vscode.html?issue=${encodeURIComponent(props.issueKey)}&view=${initialView}`;
  const [activeView, setActiveView] = createSignal<WorkbenchView | undefined>(initialView, { ownedWrite: true });
  const [frame, setFrame] = createSignal<HTMLIFrameElement | undefined>(undefined, { ownedWrite: true });
  const [blameHover, setBlameHover] = createSignal<WorkbenchBlameHover | undefined>(undefined, { ownedWrite: true });
  let blameHideTimer: ReturnType<typeof setTimeout> | undefined;
  let blameHovering = false;
  const cancelBlameHide = () => { if (blameHideTimer) clearTimeout(blameHideTimer); blameHideTimer = undefined; };
  const scheduleBlameHide = () => { cancelBlameHide(); blameHideTimer = setTimeout(() => setBlameHover(undefined), 500); };
  const [workbenchReady, setWorkbenchReady] = createSignal(false, { ownedWrite: true });
  const toggleView = (view: WorkbenchView) => {
    const visible = activeView() !== view;
    setActiveView(visible ? view : undefined);
    frame()?.contentWindow?.postMessage({ kind: "issue-pilot-workbench-view", issueKey: props.issueKey, view, visible }, window.location.origin);
  };
  let removeLayoutListener = () => {};
  createEffect(frame, (currentFrame) => {
    removeLayoutListener();
    setBlameHover(undefined);
    setWorkbenchReady(false);
    if (!currentFrame) return;
    const receiveLayout = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || event.source !== currentFrame.contentWindow) return;
      const message = event.data as { kind?: unknown; issueKey?: unknown; visible?: unknown; rect?: unknown; detail?: unknown; panel?: unknown; auxiliary?: unknown; panelVisible?: unknown; auxiliaryVisible?: unknown } | null;
      if (message?.issueKey !== props.issueKey) return;
      if (message.kind === "issue-pilot-workbench-blame-hover" && typeof message.visible === "boolean") {
        if (!message.visible) {
          if (!blameHovering) scheduleBlameHide();
        } else if (validRect(message.rect) && validBlameDetail(message.detail)) {
          cancelBlameHide();
          setBlameHover({ ...message.detail, left: Math.max(12, Math.min(currentFrame.offsetLeft + currentFrame.clientWidth - 452, currentFrame.offsetLeft + message.rect.x + message.rect.width - 440)), bottom: Math.max(0, currentFrame.clientHeight - message.rect.y) });
        }
        return;
      }
      if (message.kind !== "issue-pilot-workbench-layout" || !validRect(message.panel) || !validRect(message.auxiliary)) return;
      const visibleRect = (rect: WorkbenchPartRect): WorkbenchPartRect => ({
        x: Math.min(rect.x, currentFrame.clientWidth) + currentFrame.offsetLeft,
        y: Math.min(rect.y, currentFrame.clientHeight) + currentFrame.offsetTop,
        width: Math.min(rect.width, Math.max(0, currentFrame.clientWidth - rect.x)),
        height: Math.min(rect.height, Math.max(0, currentFrame.clientHeight - rect.y)),
      });
      setWorkbenchReady(true);
      props.onLayout({ panel: visibleRect(message.panel), auxiliary: visibleRect(message.auxiliary) });
      if (typeof message.panelVisible === "boolean" && typeof message.auxiliaryVisible === "boolean") {
        props.onPartVisibility(message.panelVisible, currentFrame.clientWidth < 700 ? undefined : message.auxiliaryVisible);
      }
    };
    window.addEventListener("message", receiveLayout);
    removeLayoutListener = () => window.removeEventListener("message", receiveLayout);
  });
  onCleanup(() => { removeLayoutListener(); cancelBlameHide(); });
  createEffect(() => ({ currentFrame: frame(), issueKey: props.issueKey, panelOpen: props.agentOpen, auxiliaryOpen: props.detailsOpen }), ({ currentFrame, issueKey, panelOpen, auxiliaryOpen }) => {
    currentFrame?.contentWindow?.postMessage({ kind: "issue-pilot-workbench-parts", issueKey, panelOpen, auxiliaryOpen }, window.location.origin);
  });

  return (
    <section class="source-browser" aria-label={`${props.issueKey} 代码浏览器`} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
      <header class="source-browser-header source-browser-header-workbench">
        <div class="source-browser-title"><Code2 size={16} /><strong>代码</strong><small>{props.issueKey}</small></div>
        <div class="source-view-switcher" role="toolbar" aria-label="代码视图">
          <Button class={activeView() === "explorer" ? "active" : ""} type="text" shape="circle" icon={<File size={16} />} title="Explorer" aria-label="Explorer" aria-pressed={activeView() === "explorer" ? "true" : "false"} onClick={() => toggleView("explorer")} />
          <Button class={activeView() === "search" ? "active" : ""} type="text" shape="circle" icon={<Search size={16} />} title="Search" aria-label="Search" aria-pressed={activeView() === "search" ? "true" : "false"} onClick={() => toggleView("search")} />
          <Button class={activeView() === "source-control" ? "active" : ""} type="text" shape="circle" icon={<GitBranch size={16} />} title="Source Control" aria-label="Source Control" aria-pressed={activeView() === "source-control" ? "true" : "false"} onClick={() => toggleView("source-control")} />
        </div>
        <Button class={props.agentOpen ? "source-panel-toggle active" : "source-panel-toggle"} type="text" shape="circle" icon={<PanelBottom size={16} />} title="Agent面板" aria-label="Agent面板" aria-pressed={props.agentOpen ? "true" : "false"} onClick={props.onToggleAgent} />
        <Button class={props.detailsOpen ? "source-details-toggle active" : "source-details-toggle"} type="text" shape="circle" icon={<PanelRight size={16} />} title="工单详情" aria-label="工单详情" aria-pressed={props.detailsOpen ? "true" : "false"} onClick={props.onToggleDetails} />
        <Button type="text" shape="circle" icon={<X size={16} />} title="关闭代码浏览器" aria-label="关闭代码浏览器" onClick={props.onClose} />
      </header>
      <iframe
        ref={setFrame}
        class="source-workbench-frame"
        src={workbenchUrl()}
        title={`${props.issueKey} VS Code工作台`}
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"
      />
      <Show when={blameHover()}>{(hover) => (
        <div class="source-blame-hover" role="tooltip" style={`left:${hover().left}px;bottom:${hover().bottom}px`} onPointerEnter={() => { blameHovering = true; cancelBlameHide(); }} onPointerLeave={() => { blameHovering = false; scheduleBlameHide(); }}>
          <strong>{hover().author}</strong>
          <Show when={hover().date}><time>{new Date(hover().date!).toLocaleString()}</time></Show>
          <p>{hover().subject}</p>
          <Show when={hover().commit}><code>{hover().commit}</code></Show>
          <small>{hover().path}:{hover().line}</small>
        </div>
      )}</Show>
      <Show when={!workbenchReady()}><div class="source-workbench-loading" role="status" aria-label="代码工作台加载中"><span /></div></Show>
    </section>
  );
}
