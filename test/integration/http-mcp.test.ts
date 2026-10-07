import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createTestRuntime } from "../helpers/runtime.js";

test("MCP accepts 2025-era initialization in stateless mode", async () => {
  const runtime = await createTestRuntime();
  try {
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    for (const protocolVersion of ["2025-03-26", "2025-06-18", "2025-11-25"]) {
      const response: Response = await fetch(
        `http://127.0.0.1:${address.port}/mcp`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": protocolVersion,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion,
              capabilities: {},
              clientInfo: { name: "stateless-test", version: "1.0.0" },
            },
          }),
        },
      );
      assert.equal(response.status, 200, protocolVersion);
      assert.match(await response.text(), new RegExp(protocolVersion));
    }
  } finally {
    await runtime.cleanup();
  }
});

async function requestWithHost(
  port: number,
  requestPath: string,
  options: {
    method: string;
    host: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: requestPath,
        method: options.method,
        headers: { host: options.host, ...(options.headers ?? {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.body) request.end(options.body);
    else request.end();
  });
}

test("remote WebUI mutations require same-origin while loopback WebUI stays local", async () => {
  const runtime = await createTestRuntime({
    configure(config) {
      config.auth.webPublicBaseUrl = "https://chatroom.example.com";
    },
  });
  try {
    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const base = `http://127.0.0.1:${address.port}`;

    const local = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: "not-required-locally" }),
    });
    assert.equal(local.status, 200);

    const rejected = await requestWithHost(address.port, "/api/auth/login", {
      method: "POST",
      host: "chatroom.example.com",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerToken: "test-owner-token" }),
    });
    assert.equal(rejected.status, 403);

    const invalidBody = await requestWithHost(address.port, "/api/auth/login", {
      method: "POST",
      host: "chatroom.example.com",
      headers: {
        "content-type": "application/json",
        origin: "https://chatroom.example.com",
      },
      body: "null",
    });
    assert.equal(invalidBody.status, 400);

    const accepted = await requestWithHost(address.port, "/api/auth/login", {
      method: "POST",
      host: "chatroom.example.com",
      headers: {
        "content-type": "application/json",
        origin: "https://chatroom.example.com",
      },
      body: JSON.stringify({ ownerToken: "test-owner-token" }),
    });
    assert.equal(accepted.status, 200);
    const cookie = accepted.headers["set-cookie"]?.[0];
    assert.ok(cookie);
    assert.match(cookie, /Secure/);

    runtime.components.computer.setSettings({
      enabled: true,
      remoteAccess: false,
    });
    const blockedComputerPreview = await requestWithHost(
      address.port,
      "/api/computer/preview",
      {
        method: "GET",
        host: "chatroom.example.com",
        headers: { cookie },
      },
    );
    assert.equal(
      blockedComputerPreview.status,
      403,
      "remote WebUI must not read Computer screenshots while remote access is disabled",
    );

    runtime.components.computer.setSettings({ remoteAccess: true });
    const allowedComputerPreview = await requestWithHost(
      address.port,
      "/api/computer/preview",
      {
        method: "GET",
        host: "chatroom.example.com",
        headers: { cookie },
      },
    );
    assert.equal(allowedComputerPreview.status, 200);
    assert.equal(allowedComputerPreview.body, "null");

    const wrongOrigin = await requestWithHost(address.port, "/api/operations", {
      method: "DELETE",
      host: "chatroom.example.com",
      headers: { cookie, origin: "https://evil.example.com" },
    });
    assert.equal(wrongOrigin.status, 403);

    const sameOrigin = await requestWithHost(address.port, "/api/operations", {
      method: "DELETE",
      host: "chatroom.example.com",
      headers: { cookie, origin: "https://chatroom.example.com" },
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    await runtime.cleanup();
  }
});
