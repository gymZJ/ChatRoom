import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { childEnvironment } from "./child-environment.js";

export interface LineProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onStdout(line: string): void;
  onStderr(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
  onError(error: Error): void;
}

export class LineProcess {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(options: LineProcessOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: childEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    createInterface({ input: this.child.stdout }).on("line", options.onStdout);
    createInterface({ input: this.child.stderr }).on("line", options.onStderr);
    this.child.once("exit", options.onExit);
    this.child.once("error", options.onError);
  }

  async spawned(): Promise<void> {
    if (this.child.pid) return;
    await new Promise<void>((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  writeLine(line: string): void {
    if (!this.child.stdin.writable)
      throw new Error("Child process stdin is not writable");
    this.child.stdin.write(line + "\n");
  }

  terminate(): void {
    if (this.child.exitCode === null) this.child.kill("SIGTERM");
  }

  forceKill(): void {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
