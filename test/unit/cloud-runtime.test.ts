import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { CLOUD_LEASE_SCHEMA } from "../../src/plugins/cloud/types.js";
import {
  CloudTunnelClient,
  parseTunnelControlMessage,
} from "../../src/plugins/cloud/tunnel-client.js";

test("Cloud tunnel pins forwarded Host to the leased public origin", async () => {
  let resolveHost!: (host: string | undefined) => void;
  const receivedHost = new Promise<string | undefined>((resolve) => {
    resolveHost = resolve;
  });
  const server = createServer((request, response) => {
    resolveHost(request.headers.host);
    response.statusCode = 204;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address() as AddressInfo;
  const lease = CLOUD_LEASE_SCHEMA.parse({
    token: "lease-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    tunnelUrl: "wss://tunnel.example.com",
    mcpBaseUrl: null,
    webBaseUrl: "https://web.example.com",
    services: ["remote_web"],
  });
  const client = new CloudTunnelClient(
    lease,
    { devicePrivateKey: "unused" },
    { host: "127.0.0.1", port: address.port },
    {
      onConnected() {},
      onDisconnected() {},
      onLeaseRejected() {},
      onError() {},
    },
  );

  try {
    const internal = client as unknown as {
      openStream(message: {
        type: "open";
        streamId: number;
        service: "web";
        method: string;
        path: string;
        headers: Record<string, string>;
      }): void;
      handleControl(message: { type: "end"; streamId: number }): void;
    };
    internal.openStream({
      type: "open",
      streamId: 1,
      service: "web",
      method: "GET",
      path: "/api/runtime",
      headers: { host: "localhost" },
    });
    internal.handleControl({ type: "end", streamId: 1 });
    assert.equal(await receivedHost, "web.example.com");
  } finally {
    client.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Cloud tunnel control messages are validated before use", () => {
  assert.deepEqual(
    parseTunnelControlMessage(
      JSON.stringify({
        type: "open",
        streamId: 7,
        service: "web",
        method: "GET",
        path: "/api/runtime",
        headers: { accept: "application/json" },
      }),
    ),
    {
      type: "open",
      streamId: 7,
      service: "web",
      method: "GET",
      path: "/api/runtime",
      headers: { accept: "application/json" },
    },
  );
  assert.throws(() =>
    parseTunnelControlMessage(
      JSON.stringify({
        type: "open",
        streamId: -1,
        service: "admin",
        method: "GET",
        path: "/",
        headers: {},
      }),
    ),
  );
  assert.throws(() =>
    parseTunnelControlMessage(
      JSON.stringify({ type: "ready", unexpected: true }),
    ),
  );
});
