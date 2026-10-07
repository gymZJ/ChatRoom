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

export function buildProjectTree(paths: readonly string[]): ProjectTreeRow[] {
  const entries = new Map<string, "file" | "directory">();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1)
      entries.set(parts.slice(0, index).join("/"), "directory");
    entries.set(filePath, "file");
  }

  return [...entries]
    .map(([path, type]) => {
      const parts = path.split("/");
      const ancestors: string[] = [];
      let parent = "";
      for (const segment of parts.slice(0, -1)) {
        parent = parent ? parent + "/" + segment : segment;
        ancestors.push(parent);
      }
      return {
        path,
        name: parts.at(-1) ?? path,
        type,
        depth: Math.max(0, parts.length - 1),
        ancestors,
      };
    })
    .sort((left, right) => {
      const leftParent = left.ancestors.at(-1) ?? "";
      const rightParent = right.ancestors.at(-1) ?? "";
      if (leftParent === rightParent && left.type !== right.type)
        return left.type === "directory" ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
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
