import type { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { SyncDescriptor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors";
import type { IEditorOverrideServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import {
  FileMatch,
  OneLineRange,
  SearchCompletionExitCode,
  SearchProviderType,
  TextSearchCompleteMessageType,
  TextSearchMatch,
  type IFileQuery,
  type ISearchComplete,
  type ISearchProgressItem,
  type ISearchResultProvider,
  type ITextQuery,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search";
import { ISearchService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import { SearchService } from "@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService";

import { searchSource, type SourceRepository } from "../data/client";

interface SearchRoot {
  repository: string;
  relativePath: string;
}

export function getBudgetedSearchServiceOverride(): IEditorOverrideServices {
  const overrides = getSearchServiceOverride();
  overrides[ISearchService.toString()] = new SyncDescriptor(SearchService, [], true);
  return overrides;
}

export class SourceSearchProvider implements ISearchResultProvider {
  private readonly repositoryNames: Set<string>;
  private readonly workspacePrefix: string;

  constructor(private readonly issueKey: string, repositories: SourceRepository[]) {
    this.repositoryNames = new Set(repositories.map((repository) => repository.name));
    this.workspacePrefix = `/issue-pilot/${issueKey}/`;
  }

  async getAIName(): Promise<string | undefined> {
    return undefined;
  }

  async textSearch(query: ITextQuery, onProgress?: (progress: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
    const pattern = query.contentPattern.pattern;
    if (!pattern || query.contentPattern.isRegExp) {
      return this.complete([], false, query.contentPattern.isRegExp ? "Issue Pilot代码搜索只支持纯文本" : undefined);
    }
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const files = new Map<string, FileMatch>();
    let resultCount = 0;
    let limitHit = false;
    const maxResults = Math.max(0, query.maxResults ?? Number.MAX_SAFE_INTEGER);
    try {
      for (const folderQuery of query.folderQueries) {
        if (token?.isCancellationRequested || resultCount >= maxResults) break;
        const root = this.searchRoot(folderQuery.folder);
        if (!root) continue;
        const response = await searchSource(this.issueKey, root.repository, pattern, {
          caseSensitive: query.contentPattern.isCaseSensitive === true,
          wordMatch: query.contentPattern.isWordMatch === true,
        }, controller.signal);
        limitHit ||= response.truncated;
        for (const match of response.matches) {
          if (token?.isCancellationRequested || resultCount >= maxResults) {
            limitHit = true;
            break;
          }
          if (root.relativePath && match.path !== root.relativePath && !match.path.startsWith(`${root.relativePath}/`)) continue;
          const resource = URI.file(`${this.workspacePrefix}${root.repository}/${match.path}`);
          const key = resource.toString();
          let file = files.get(key);
          if (!file) {
            file = new FileMatch(resource);
            files.set(key, file);
          }
          const previewColumn = this.previewColumn(match.preview, pattern, query.contentPattern.isCaseSensitive === true, match.column - 1);
          file.results.push(new TextSearchMatch(
            match.preview,
            new OneLineRange(match.line - 1, previewColumn, previewColumn + pattern.length),
            query.previewOptions,
          ));
          resultCount += 1;
        }
      }
      const results = [...files.values()];
      for (const result of results) onProgress?.(result);
      return this.complete(results, limitHit);
    } finally {
      cancellation?.dispose();
    }
  }

  async fileSearch(_query: IFileQuery, _token?: CancellationToken): Promise<ISearchComplete> {
    return {
      results: [],
      limitHit: false,
      messages: [],
      exit: SearchCompletionExitCode.Normal,
      stats: { type: "fileSearchProvider", fromCache: false, resultCount: 0, detailStats: { providerTime: 0, postProcessTime: 0 } },
    };
  }

  async clearCache(_cacheKey: string): Promise<void> {}

  private complete(results: FileMatch[], limitHit: boolean, warning?: string): ISearchComplete {
    return {
      results,
      limitHit,
      messages: warning ? [{ text: warning, type: TextSearchCompleteMessageType.Warning }] : [],
      exit: SearchCompletionExitCode.Normal,
      stats: { type: "textSearchProvider" },
    };
  }

  private searchRoot(resource: URI): SearchRoot | null {
    if (!resource.path.startsWith(this.workspacePrefix)) return null;
    const relative = resource.path.slice(this.workspacePrefix.length);
    const separator = relative.indexOf("/");
    const repository = separator < 0 ? relative : relative.slice(0, separator);
    if (!this.repositoryNames.has(repository)) return null;
    return { repository, relativePath: separator < 0 ? "" : relative.slice(separator + 1) };
  }

  private previewColumn(preview: string, pattern: string, caseSensitive: boolean, fallback: number): number {
    const column = caseSensitive ? preview.indexOf(pattern) : preview.toLocaleLowerCase().indexOf(pattern.toLocaleLowerCase());
    return column >= 0 ? column : Math.max(0, fallback);
  }
}

export async function registerSourceSearch(provider: SourceSearchProvider): Promise<void> {
  const search = await import("@codingame/monaco-vscode-api/services").then(({ getService }) => getService(ISearchService));
  search.registerSearchResultProvider("file", SearchProviderType.file, provider);
  search.registerSearchResultProvider("file", SearchProviderType.text, provider);
}
