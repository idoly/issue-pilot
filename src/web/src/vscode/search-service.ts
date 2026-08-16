import type { IEditorOverrideServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import { SyncDescriptor } from "@codingame/monaco-vscode-api/vscode/vs/platform/instantiation/common/descriptors";
import { ISearchService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/search/common/search.service";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import { SearchService } from "@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService";

// The default override crawls the virtual file tree; Source API search enforces the server-side result budget instead.
export function getBudgetedSearchServiceOverride(): IEditorOverrideServices {
  const overrides = getSearchServiceOverride();
  overrides[ISearchService.toString()] = new SyncDescriptor(SearchService, [], true);
  return overrides;
}
