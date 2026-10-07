import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeEventBus } from "../../src/app/event-bus.js";
import { ComputerService } from "../../src/plugins/computer/computer-service.js";
import type {
  ComputerBackend,
  ComputerSettings,
  ComputerSnapshot,
} from "../../src/plugins/computer/types.js";

test("ComputerService retains the current and previous screenshot for binary preview races", async () => {
  let settings: ComputerSettings = {
    enabled: true,
    remoteAccess: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let sequence = 0;
  const backend: ComputerBackend = {
    async status() {
      return {
        platform: "linux",
        helper: "running",
        permissions: {
          accessibility: "not-required",
          screenRecording: "not-required",
        },
        displays: [],
      };
    },
    async requestPermission() {
      return this.status();
    },
    async snapshot(_request, revision) {
      sequence += 1;
      return snapshot(`snap_${sequence}`, revision, `image_${sequence}`);
    },
    async action() {
      return {
        success: true,
        revision: 0,
        executionMode: "foreground",
        focusChanged: false,
      };
    },
    async dispose() {},
  };

  const service = new ComputerService(
    backend,
    {
      get: () => settings,
      set: (next) => {
        settings = {
          ...next,
          updatedAt: new Date().toISOString(),
        };
        return settings;
      },
    },
    new RuntimeEventBus(),
  );

  await service.snapshot("local", {
    includeScreenshot: true,
    includeElements: false,
  });
  await service.snapshot("local", {
    includeScreenshot: true,
    includeElements: false,
  });

  assert.equal(service.screenshot("local", "snap_1")?.data, "image_1");
  assert.equal(service.screenshot("local", "snap_2")?.data, "image_2");

  await service.snapshot("local", {
    includeScreenshot: true,
    includeElements: false,
  });

  assert.equal(service.screenshot("local", "snap_1"), null);
  assert.equal(service.screenshot("local", "snap_2")?.data, "image_2");
  assert.equal(service.screenshot("local", "snap_3")?.data, "image_3");

  service.setSettings({ enabled: false });
  assert.equal(service.screenshot("local", "snap_3"), null);
});

function snapshot(
  snapshotId: string,
  revision: number,
  data: string,
): ComputerSnapshot {
  return {
    snapshotId,
    revision,
    display: null,
    activeApp: null,
    activeWindow: null,
    cursor: null,
    elements: [],
    screenshot: { mimeType: "image/png", data },
  };
}
