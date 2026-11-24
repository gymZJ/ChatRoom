import type { LogWriter } from "#core/logging/types";

const GIB = 1024 * 1024 * 1024;

export interface MemoryWatchOptions {
  intervalMs?: number;
  /** First RSS level that is reported; each doubling is reported again. */
  thresholdBytes?: number;
  sample?: () => NodeJS.MemoryUsage;
}

/**
 * Samples process memory and logs a warning with a heap breakdown whenever
 * RSS crosses the threshold or a doubling of it, so unexpected growth leaves
 * a trace in the system log. The level re-arms once usage halves again.
 * Returns a function that stops the watch.
 */
export function startMemoryWatch(
  logs: LogWriter,
  {
    intervalMs = 5 * 60 * 1000,
    thresholdBytes = GIB,
    sample = () => process.memoryUsage(),
  }: MemoryWatchOptions = {},
): () => void {
  let reported = 0;
  const check = () => {
    const usage = sample();
    if (reported && usage.rss < reported / 2) reported = 0;
    let level = reported ? reported * 2 : thresholdBytes;
    if (usage.rss < level) return;
    while (usage.rss >= level * 2) level *= 2;
    reported = level;
    logs.warn("app", "app.memory_high", "Process memory usage is high", {
      rssMiB: mib(usage.rss),
      heapUsedMiB: mib(usage.heapUsed),
      heapTotalMiB: mib(usage.heapTotal),
      externalMiB: mib(usage.external),
      arrayBuffersMiB: mib(usage.arrayBuffers),
      thresholdMiB: mib(level),
    });
  };
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
