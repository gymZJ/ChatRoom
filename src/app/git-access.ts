import { createServiceToken } from "#app/service-registry";

export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface GitChange {
  path: string;
  originalPath: string | null;
  indexStatus: string;
  workingTreeStatus: string;
  kind: GitChangeKind;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface GitDiff {
  diff: string;
  truncated: boolean;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitAccess {
  projectFiles(cwd: string, maxFiles?: number): Promise<string[] | null>;
  status(cwd: string): Promise<GitStatus | null>;
  diff(
    cwd: string,
    filePath?: string,
    maxPreviewBytes?: number,
  ): Promise<GitDiff>;
  stage(cwd: string, paths: string[]): Promise<GitStatus>;
  unstage(cwd: string, paths: string[]): Promise<GitStatus>;
  restore(cwd: string, filePath: string): Promise<GitStatus>;
  commit(cwd: string, message: string): Promise<GitStatus>;
  branches(cwd: string): Promise<GitBranch[]>;
  createBranch(cwd: string, name: string): Promise<GitStatus>;
  switchBranch(cwd: string, name: string): Promise<GitStatus>;
  deleteBranch(cwd: string, name: string): Promise<GitStatus>;
  log(cwd: string, limit?: number): Promise<GitCommit[]>;
  fetch(cwd: string): Promise<GitStatus>;
  pull(cwd: string): Promise<GitStatus>;
  push(cwd: string): Promise<GitStatus>;
}

export const GitAccessToken = createServiceToken<GitAccess>("git-access");
