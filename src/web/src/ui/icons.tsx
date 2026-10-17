import type { IconNode } from "lucide";
import {
  ArrowDown as ArrowDownNode,
  CheckCircle2 as CheckCircle2Node,
  ChevronDown as ChevronDownNode,
  ChevronRight as ChevronRightNode,
  Code2 as Code2Node,
  Copy as CopyNode,
  Download as DownloadNode,
  Eye as EyeNode,
  File as FileNode,
  GitBranch as GitBranchNode,
  MessageSquare as MessageSquareNode,
  Maximize2 as Maximize2Node,
  PanelBottom as PanelBottomNode,
  PanelRight as PanelRightNode,
  Paperclip as PaperclipNode,
  Pencil as PencilNode,
  Pin as PinNode,
  Plus as PlusNode,
  RefreshCw as RefreshCwNode,
  Search as SearchNode,
  Send as SendNode,
  Trash2 as Trash2Node,
  UserCheck as UserCheckNode,
  UserPlus as UserPlusNode,
  UserX as UserXNode,
  X as XNode,
  ZoomIn as ZoomInNode,
  ZoomOut as ZoomOutNode,
} from "lucide";
import { Dynamic, type JSX } from "@solidjs/web";
import { omit } from "solid-js";

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

export const ArrowDown = createIcon(ArrowDownNode);
export const CheckCircle2 = createIcon(CheckCircle2Node);
export const ChevronDown = createIcon(ChevronDownNode);
export const ChevronRight = createIcon(ChevronRightNode);
export const Code2 = createIcon(Code2Node);
export const Copy = createIcon(CopyNode);
export const Download = createIcon(DownloadNode);
export const Eye = createIcon(EyeNode);
export const File = createIcon(FileNode);
export const GitBranch = createIcon(GitBranchNode);
export const MessageSquare = createIcon(MessageSquareNode);
export const Maximize2 = createIcon(Maximize2Node);
export const PanelBottom = createIcon(PanelBottomNode);
export const PanelRight = createIcon(PanelRightNode);
export const Paperclip = createIcon(PaperclipNode);
export const Pencil = createIcon(PencilNode);
export const Pin = createIcon(PinNode);
export const Plus = createIcon(PlusNode);
export const RefreshCw = createIcon(RefreshCwNode);
export const Search = createIcon(SearchNode);
export const Send = createIcon(SendNode);
export const Trash2 = createIcon(Trash2Node);
export const UserCheck = createIcon(UserCheckNode);
export const UserPlus = createIcon(UserPlusNode);
export const UserX = createIcon(UserXNode);
export const X = createIcon(XNode);
export const ZoomIn = createIcon(ZoomInNode);
export const ZoomOut = createIcon(ZoomOutNode);
