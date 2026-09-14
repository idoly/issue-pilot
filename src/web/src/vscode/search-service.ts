import { ISearchService, SyncDescriptor, type IEditorOverrideServices } from "@codingame/monaco-vscode-api";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import { SearchService } from "@codingame/monaco-vscode-search-service-override/vscode/vs/workbench/services/search/common/searchService";

// The default override crawls the virtual file tree; Source API search enforces the server-side result budget instead.
export function getBudgetedSearchServiceOverride(): IEditorOverrideServices {
  const overrides = getSearchServiceOverride();
  overrides[ISearchService.toString()] = new SyncDescriptor(SearchService, [], true);
  return overrides;
}
