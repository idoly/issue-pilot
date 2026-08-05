import type { IconNode } from "lucide";
import {
  CheckCircle2 as CheckCircle2Node,
  ChevronLeft as ChevronLeftNode,
  ChevronRight as ChevronRightNode,
  Copy as CopyNode,
  Download as DownloadNode,
  ExternalLink as ExternalLinkNode,
  Eye as EyeNode,
  GitBranch as GitBranchNode,
  GripVertical as GripVerticalNode,
  ListFilter as ListFilterNode,
  MessageSquare as MessageSquareNode,
  Maximize2 as Maximize2Node,
  Minimize2 as Minimize2Node,
  Paperclip as PaperclipNode,
  Pencil as PencilNode,
  Plus as PlusNode,
  RefreshCw as RefreshCwNode,
  Search as SearchNode,
  Send as SendNode,
  SquareTerminal as TerminalSquareNode,
  Trash2 as Trash2Node,
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

export const CheckCircle2 = createIcon(CheckCircle2Node);
export const ChevronLeft = createIcon(ChevronLeftNode);
export const ChevronRight = createIcon(ChevronRightNode);
export const Copy = createIcon(CopyNode);
export const Download = createIcon(DownloadNode);
export const ExternalLink = createIcon(ExternalLinkNode);
export const Eye = createIcon(EyeNode);
export const GitBranch = createIcon(GitBranchNode);
export const GripVertical = createIcon(GripVerticalNode);
export const ListFilter = createIcon(ListFilterNode);
export const MessageSquare = createIcon(MessageSquareNode);
export const Maximize2 = createIcon(Maximize2Node);
export const Minimize2 = createIcon(Minimize2Node);
export const Paperclip = createIcon(PaperclipNode);
export const Pencil = createIcon(PencilNode);
export const Plus = createIcon(PlusNode);
export const RefreshCw = createIcon(RefreshCwNode);
export const Search = createIcon(SearchNode);
export const Send = createIcon(SendNode);
export const TerminalSquare = createIcon(TerminalSquareNode);
export const Trash2 = createIcon(Trash2Node);
export const ZoomIn = createIcon(ZoomInNode);
export const ZoomOut = createIcon(ZoomOutNode);
