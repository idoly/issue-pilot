import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import "monaco-editor-codicons.css";
import "./icons.css";

// Names and code points from the pinned Monaco Codicon font.
const glyphs = {
  account: 0xeb99, "arrow-down": 0xea9a, attach: 0xec34, "case-sensitive": 0xeab1,
  check: 0xeab2, "chevron-down": 0xeab4, "chevron-right": 0xeab6,
  close: 0xea76, "cloud-download": 0xeac2, code: 0xeac4, comment: 0xea6b, copy: 0xebcc,
  "diff-multiple": 0xec23, edit: 0xea73, eye: 0xea70, file: 0xea7b, folder: 0xea83,
  "git-branch": 0xec6f, "git-commit": 0xeafc, "go-to-file": 0xea94,
  "layout-panel": 0xebf2, history: 0xea82, organization: 0xea7e, repo: 0xea62, "layout-sidebar-right": 0xebf4, "lock-small": 0xebe7,
  pass: 0xeba4, pin: 0xeb2b, plus: 0xea60,
  refresh: 0xeb37, replace: 0xeb3d, "screen-full": 0xeb4c, search: 0xea6d,
  target: 0xebf8, trash: 0xea81, "vm-outline": 0xeb7a, "whole-word": 0xeb7e,
  "zoom-in": 0xeb81, "zoom-out": 0xeb82,
} as const;

interface IconProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "style"> {
  size?: number;
}

export function Codicon(props: IconProps & { name: keyof typeof glyphs }) {
  const others = omit(props, "name", "size", "class");
  return <i aria-hidden="true" {...others} class={`ui-icon ${props.class ?? ""}`} data-icon={String.fromCodePoint(glyphs[props.name])} style={{ "font-size": `${props.size ?? 16}px` }} />;
}

function createIcon(name: keyof typeof glyphs) {
  return (props: IconProps) => <Codicon {...props} name={name} size={props.size ?? 24} />;
}

export const ArrowDown = createIcon("arrow-down");
export const CheckCircle2 = createIcon("pass");
export const ChevronDown = createIcon("chevron-down");
export const ChevronRight = createIcon("chevron-right");
export const Code2 = createIcon("code");
export const Copy = createIcon("copy");
export const Download = createIcon("cloud-download");
export const Eye = createIcon("eye");
export const File = createIcon("file");
export const Folder = createIcon("folder");
export const GitBranch = createIcon("git-branch");
export const History = createIcon("history");
export const Organization = createIcon("organization");
export const Repo = createIcon("repo");
export const MessageSquare = createIcon("comment");
export const Maximize2 = createIcon("screen-full");
export const PanelBottom = createIcon("layout-panel");
export const PanelRight = createIcon("layout-sidebar-right");
export const Paperclip = createIcon("attach");
export const Pencil = createIcon("edit");
export const Pin = createIcon("pin");
export const Plus = createIcon("plus");
export const RefreshCw = createIcon("refresh");
export const Search = createIcon("search");
export const Trash2 = createIcon("trash");
export const X = createIcon("close");
export const ZoomIn = createIcon("zoom-in");
export const ZoomOut = createIcon("zoom-out");
