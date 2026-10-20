export const SOURCE_COMMIT_FILE_STATUSES = ["added", "modified", "deleted", "renamed", "copied"] as const;
export const SOURCE_WORKSPACE_FILE_VERSIONS = ["head", "index", "working-tree"] as const;

export interface SourceRepository {
  name: string;
  url: string;
  branch: string;
  access: "read" | "write";
}

export interface SourceTreeEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink" | "other";
  size: number | null;
}

export interface SourceTree {
  path: string;
  entries: SourceTreeEntry[];
  truncated: boolean;
}

export interface SourceFile {
  path: string;
  content: string;
  size: number;
  sha256: string;
}

export interface SourceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SourceCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

export interface SourceHistoryCursor { revision: string; offset: number }
export interface SourceHistoryPage { commits: SourceCommit[]; truncated: boolean; nextCursor: SourceHistoryCursor | null }

export interface SourceCommitFile {
  status: typeof SOURCE_COMMIT_FILE_STATUSES[number];
  path: string;
  previousPath: string | null;
}

export interface SourceChanges {
  files: SourceCommitFile[];
  truncated: boolean;
}

export interface SourceBlame {
  path: string;
  line: number;
  commit: string | null;
  shortCommit: string | null;
  author: string;
  date: string | null;
  subject: string;
}

export interface SourceRevisionFile {
  path: string;
  revision: string;
  content: string;
}

export interface SourceWorkspaceFile {
  path: string;
  version: typeof SOURCE_WORKSPACE_FILE_VERSIONS[number];
  content: string;
}

export interface SourceCommitFileComparison {
  file: SourceCommitFile;
  before: SourceRevisionFile | null;
  after: SourceRevisionFile | null;
}

export interface SourceWorkspaceFileComparison {
  file: SourceCommitFile;
  before: SourceWorkspaceFile | null;
  after: SourceWorkspaceFile | null;
}
