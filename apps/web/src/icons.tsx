import type { IconNode } from "lucide";
import { icons } from "lucide";
import { Dynamic } from "@solidjs/web";
import { omit } from "solid-js";
import type { JSX } from "@solidjs/web";

interface IconProps extends Omit<JSX.SvgSVGAttributes<SVGSVGElement>, "children"> {
  size?: number;
}

function createIcon(node: IconNode) {
  return (props: IconProps) => {
    const others = omit(props, "size");
    return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={props.size ?? 24}
      height={props.size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...others}
    >
      {node.map(([tag, attributes]) => <Dynamic component={tag} {...attributes} />)}
    </svg>
    );
  };
}

export const Bot = createIcon(icons.Bot);
export const CheckCircle2 = createIcon(icons.CheckCircle2);
export const ChevronLeft = createIcon(icons.ChevronLeft);
export const ChevronRight = createIcon(icons.ChevronRight);
export const CircleDot = createIcon(icons.CircleDot);
export const Database = createIcon(icons.Database);
export const ExternalLink = createIcon(icons.ExternalLink);
export const FileSearch = createIcon(icons.FileSearch);
export const GitBranch = createIcon(icons.GitBranch);
export const ListFilter = createIcon(icons.ListFilter);
export const Maximize2 = createIcon(icons.Maximize2);
export const MessageSquareText = createIcon(icons.MessageSquareText);
export const Minimize2 = createIcon(icons.Minimize2);
export const Paperclip = createIcon(icons.Paperclip);
export const Pencil = createIcon(icons.Pencil);
export const Plus = createIcon(icons.Plus);
export const Search = createIcon(icons.Search);
export const Send = createIcon(icons.Send);
export const Square = createIcon(icons.Square);
export const TerminalSquare = createIcon(icons.SquareTerminal);
export const Trash2 = createIcon(icons.Trash2);
