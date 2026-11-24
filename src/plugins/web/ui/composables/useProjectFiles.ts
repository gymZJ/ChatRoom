import { computed, shallowRef } from "vue";
import { api, type WorkspaceProjectFiles } from "../api.js";
import { agentFileName } from "../utils/agent-display.js";
import {
  buildProjectTree,
  filterProjectFiles,
  indexProjectFiles,
  type IndexedProjectFile,
  type ProjectTreeRow,
} from "../utils/agent-files.js";
import { createRequestGate } from "../utils/requests.js";
import { useDebouncedValue } from "./useDebouncedValue.js";

const SEARCH_RESULT_LIMIT = 80;

/** The workspace file index behind the composer's file picker and @mentions. */
export function useProjectFiles() {
  const paths = shallowRef<string[]>([]);
  const truncated = shallowRef(false);
  const indexed = shallowRef<IndexedProjectFile[]>([]);
  const treeIndex = shallowRef<ProjectTreeRow[]>([]);
  const expandedDirectories = shallowRef<ReadonlySet<string>>(new Set());
  const search = shallowRef("");
  const { debounced: debouncedSearch, set: setSearch } = useDebouncedValue(
    search,
    120,
  );
  const requests = createRequestGate();

  const fileSet = computed(() => new Set(paths.value));
  const treeRows = computed<ProjectTreeRow[]>(() => {
    if (debouncedSearch.value.trim())
      return matching(debouncedSearch.value, SEARCH_RESULT_LIMIT).map(
        (filePath) => ({
          path: filePath,
          name: agentFileName(filePath),
          type: "file",
          depth: 0,
          ancestors: [],
        }),
      );
    return treeIndex.value.filter((row) =>
      row.ancestors.every((parent) => expandedDirectories.value.has(parent)),
    );
  });

  function matching(query: string, limit: number): string[] {
    return filterProjectFiles(paths.value, indexed.value, query).slice(
      0,
      limit,
    );
  }

  function apply(nextPaths: string[], nextTruncated: boolean) {
    paths.value = nextPaths;
    truncated.value = nextTruncated;
    indexed.value = indexProjectFiles(nextPaths);
    treeIndex.value = buildProjectTree(nextPaths);
  }

  /**
   * Loads the index for a workspace. Results that arrive after a newer load
   * or a reset are dropped; `isStillWanted` lets the caller veto them too.
   * Errors clear the index and are rethrown for the caller to report.
   */
  async function load(
    workspaceId: string,
    isStillWanted: () => boolean,
  ): Promise<void> {
    const request = requests.begin();
    try {
      const next = await api<WorkspaceProjectFiles>(
        "/workspace/project-files?workspaceId=" +
          encodeURIComponent(workspaceId),
        { timeoutMs: 20_000, signal: request.signal },
      );
      if (!requests.isCurrent(request) || !isStillWanted()) return;
      apply(next.paths, next.truncated);
    } catch (cause) {
      if (!requests.isCurrent(request)) return;
      apply([], false);
      throw cause;
    }
  }

  function reset() {
    requests.invalidate();
    apply([], false);
    expandedDirectories.value = new Set();
    setSearch("");
  }

  function toggleDirectory(directoryPath: string) {
    const next = new Set(expandedDirectories.value);
    if (next.has(directoryPath)) next.delete(directoryPath);
    else next.add(directoryPath);
    expandedDirectories.value = next;
  }

  return {
    truncated,
    expandedDirectories,
    search,
    fileSet,
    treeRows,
    matching,
    load,
    reset,
    toggleDirectory,
  };
}
