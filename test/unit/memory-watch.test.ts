import assert from "node:assert/strict";
import test from "node:test";
import { startMemoryWatch } from "../../src/app/memory-watch.js";

test("memory watch reports each doubling once and re-arms after usage drops", async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const logs = {
    debug() {},
    info() {},
    error() {},
    warn(
      _module: string,
      _event: string,
      _message: string,
      data?: Record<string, unknown>,
    ) {
      warnings.push(data ?? {});
    },
  };
  const mib = 1024 * 1024;
  const samples = [50, 120, 130, 250, 900, 40, 150].map((value) => value * mib);
  let index = 0;
  const stop = startMemoryWatch(logs, {
    intervalMs: 5,
    thresholdBytes: 100 * mib,
    sample: () =>
      ({
        rss: samples[Math.min(index++, samples.length - 1)]!,
        heapUsed: 0,
        heapTotal: 0,
        external: 0,
        arrayBuffers: 0,
      }) as NodeJS.MemoryUsage,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  stop();
  assert.deepEqual(
    warnings.map((warning) => [warning.rssMiB, warning.thresholdMiB]),
    [
      [120, 100],
      [250, 200],
      [900, 800],
      [150, 100],
    ],
  );
});
