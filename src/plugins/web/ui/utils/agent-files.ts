/** Document and source types the composer accepts as local uploads. */
export const AGENT_UPLOAD_FILE_TYPES: readonly string[] = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".zip",
  ".yaml",
  ".yml",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".sh",
  ".log",
  ".toml",
  ".sql",
];

export interface IndexedProjectFile {
  path: string;
  lowerPath: string;
}

export interface ProjectTreeRow {
  path: string;
  name: string;
  type: "file" | "directory";
  depth: number;
  ancestors: string[];
}

export function indexProjectFiles(
  paths: readonly string[],
): IndexedProjectFile[] {
  return paths.map((path) => ({ path, lowerPath: path.toLowerCase() }));
}

export function filterProjectFiles(
  paths: readonly string[],
  indexed: readonly IndexedProjectFile[],
  query: string,
): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...paths];
  const segments = normalized.split(/[\/\s]+/).filter(Boolean);
  return indexed
    .filter((entry) =>
      segments.every((segment) => entry.lowerPath.includes(segment)),
    )
    .sort((left, right) => {
      const leftStarts = left.lowerPath.startsWith(normalized) ? 0 : 1;
      const rightStarts = right.lowerPath.startsWith(normalized) ? 0 : 1;
      return (
        leftStarts - rightStarts ||
        left.path.length - right.path.length ||
        left.path.localeCompare(right.path)
      );
    })
    .map((entry) => entry.path);
}

/**
 * Flattens paths into tree rows in display order: depth-first, and within
 * each directory subdirectories before files, each sorted by name.
 */
export function buildProjectTree(paths: readonly string[]): ProjectTreeRow[] {
  interface Node {
    children: Map<string, Node>;
  }
  const root: Node = { children: new Map() };
  for (const filePath of paths) {
    let node = root;
    for (const segment of filePath.split("/")) {
      let child = node.children.get(segment);
      if (!child) {
        child = { children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
  }

  const rows: ProjectTreeRow[] = [];
  const visit = (node: Node, prefix: string, ancestors: string[]) => {
    const entries = [...node.children].map(([name, child]) => ({
      name,
      child,
      directory: child.children.size > 0,
    }));
    entries.sort(
      (left, right) =>
        Number(right.directory) - Number(left.directory) ||
        left.name.localeCompare(right.name),
    );
    for (const { name, child, directory } of entries) {
      const path = prefix ? prefix + "/" + name : name;
      rows.push({
        path,
        name,
        type: directory ? "directory" : "file",
        depth: ancestors.length,
        ancestors,
      });
      if (directory) visit(child, path, [...ancestors, path]);
    }
  };
  visit(root, "", []);
  return rows;
}

export function extractMentionedPaths(
  text: string,
  projectFiles: ReadonlySet<string>,
): string[] {
  const output = new Set<string>();
  const pattern = /@"([^"]+)"|@([^\s]+)/g;
  for (const match of text.matchAll(pattern)) {
    const candidate = (match[1] ?? match[2] ?? "").replace(/[),.;!?]+$/, "");
    if (projectFiles.has(candidate)) output.add(candidate);
  }
  return [...output];
}

export function imageMimeType(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  return null;
}
