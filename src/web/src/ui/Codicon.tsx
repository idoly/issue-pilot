import type { JSX } from "@solidjs/web";
import { omit } from "solid-js";
import "monaco-editor-codicons.css";
import "./icons.css";

// Editor-specific glyphs stay with the lazily loaded code browser.
const glyphs = {
  account: 0xeb99, "case-sensitive": 0xeab1,
  "chevron-down": 0xeab4, "chevron-right": 0xeab6,
  close: 0xea76, "diff-multiple": 0xec23,
  "git-branch": 0xec6f, "git-commit": 0xeafc, "go-to-file": 0xea94,
  "lock-small": 0xebe7, refresh: 0xeb37, replace: 0xeb3d,
  target: 0xebf8, "vm-outline": 0xeb7a, "whole-word": 0xeb7e,
} as const;

type CodiconProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "style"> & { size?: number; name: keyof typeof glyphs };

export function Codicon(props: CodiconProps) {
  const others = omit(props, "name", "size", "class");
  return <i aria-hidden="true" {...others} class={`ui-icon ui-codicon ${props.class ?? ""}`} data-icon={String.fromCodePoint(glyphs[props.name])} style={{ "font-size": `${props.size ?? 16}px` }} />;
}
