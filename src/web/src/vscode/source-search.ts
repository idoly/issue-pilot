import type { CancellationToken, Progress, TextSearchComplete, TextSearchOptions, TextSearchProvider, TextSearchQuery, TextSearchResult, Uri } from "vscode";

import { searchSource, type SourceRepository } from "../data/client";
import { getIssuePilotVscodeApi, type IssuePilotVscodeApi } from "./extension-api";

interface SearchRoot {
  repository: string;
  relativePath: string;
}

export class SourceSearchProvider implements TextSearchProvider {
  private readonly repositoryNames: Set<string>;
  private readonly workspacePrefix: string;

  constructor(private readonly issueKey: string, repositories: SourceRepository[], private readonly vscode: IssuePilotVscodeApi) {
    this.repositoryNames = new Set(repositories.map((repository) => repository.name));
    this.workspacePrefix = `/issue-pilot/${issueKey}/`;
  }

  async provideTextSearchResults(
    query: TextSearchQuery,
    options: TextSearchOptions,
    progress: Progress<TextSearchResult>,
    token: CancellationToken,
  ): Promise<TextSearchComplete> {
    if (!query.pattern || query.isRegExp) {
      return {
        limitHit: false,
        message: query.isRegExp ? { text: "Issue Pilot代码搜索只支持纯文本", type: this.vscode.TextSearchCompleteMessageType.Warning } : undefined,
      };
    }
    const root = this.searchRoot(options.folder);
    if (!root) return { limitHit: false };

    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    let resultCount = 0;
    let limitHit = false;
    try {
      const response = await searchSource(this.issueKey, root.repository, query.pattern, {
        caseSensitive: query.isCaseSensitive === true,
        wordMatch: query.isWordMatch === true,
      }, controller.signal);
      limitHit = response.truncated;
      for (const match of response.matches) {
        if (token.isCancellationRequested || resultCount >= options.maxResults) {
          limitHit = true;
          break;
        }
        if (root.relativePath && match.path !== root.relativePath && !match.path.startsWith(`${root.relativePath}/`)) continue;
        const sourceColumn = Math.max(0, match.column - 1);
        const previewColumn = this.previewColumn(match.preview, query.pattern, query.isCaseSensitive === true, sourceColumn);
        progress.report({
          uri: this.vscode.Uri.file(`${this.workspacePrefix}${root.repository}/${match.path}`),
          ranges: new this.vscode.Range(match.line - 1, sourceColumn, match.line - 1, sourceColumn + query.pattern.length),
          preview: {
            text: match.preview,
            matches: new this.vscode.Range(0, previewColumn, 0, previewColumn + query.pattern.length),
          },
        });
        resultCount += 1;
      }
      return { limitHit };
    } finally {
      cancellation.dispose();
    }
  }

  private searchRoot(resource: Uri): SearchRoot | null {
    if (!resource.path.startsWith(this.workspacePrefix)) return null;
    const relative = resource.path.slice(this.workspacePrefix.length);
    const separator = relative.indexOf("/");
    const repository = separator < 0 ? relative : relative.slice(0, separator);
    if (!this.repositoryNames.has(repository)) return null;
    return { repository, relativePath: separator < 0 ? "" : relative.slice(separator + 1) };
  }

  private previewColumn(preview: string, pattern: string, caseSensitive: boolean, fallback: number): number {
    const column = caseSensitive ? preview.indexOf(pattern) : preview.toLocaleLowerCase().indexOf(pattern.toLocaleLowerCase());
    return column >= 0 ? column : fallback;
  }
}

export async function registerSourceSearch(issueKey: string, repositories: SourceRepository[]): Promise<void> {
  const vscode = await getIssuePilotVscodeApi();
  vscode.workspace.registerTextSearchProvider("file", new SourceSearchProvider(issueKey, repositories, vscode));
}
