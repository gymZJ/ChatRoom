export interface WorkspaceFile {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt?: string;
}
