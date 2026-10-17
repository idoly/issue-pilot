import themeData from "material-icon-theme/dist/material-icons.json";
import { version } from "material-icon-theme/package.json";
import "./editor-codicons.css";

type IconTheme = {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string; folder: string; folderExpanded: string; rootFolder: string; rootFolderExpanded: string;
};
const theme = themeData as IconTheme;

export function EditorFileIcon(props: { path: string; directory?: boolean; expanded?: boolean; root?: boolean }) {
  const source = () => {
    const name = props.path.split("/").at(-1)?.toLowerCase() ?? "";
    let key: string | undefined;
    if (props.root) key = props.expanded ? theme.rootFolderExpanded : theme.rootFolder;
    else if (props.directory) key = (props.expanded ? theme.folderNamesExpanded : theme.folderNames)[name] ?? (props.expanded ? theme.folderExpanded : theme.folder);
    else {
      key = theme.fileNames[name];
      const parts = name.split(".");
      for (let index = 1; !key && index < parts.length; index++) key = theme.fileExtensions[parts.slice(index).join(".")];
      key ??= theme.file;
    }
    const file = theme.iconDefinitions[key]?.iconPath.split("/").at(-1);
    return file ? `/assets/editor-icons-${version}/${encodeURIComponent(file)}` : undefined;
  };
  return <img class="editor-file-icon" draggable={false} src={source()} alt="" aria-hidden="true" width="16" height="16" />;
}

export function Codicon(props: { name: string; size?: number }) {
  return <i class={`codicon codicon-${props.name}`} aria-hidden="true" style={{ "font-size": `${props.size ?? 16}px` }} />;
}
