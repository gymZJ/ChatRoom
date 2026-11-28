import type { Request } from "express";
import type { ChatRoomConfig } from "#config/types";
import type {
  ExternalAccessRegistry,
  ExternalAccessKind,
} from "#app/external-access-registry";

export interface WebAuthnOrigin {
  origin: string;
  rpId: string;
}

export class IngressPolicy {
  private readonly staticHosts: ReadonlySet<string>;

  constructor(
    private readonly config: ChatRoomConfig,
    private readonly externalAccess: ExternalAccessRegistry,
  ) {
    const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
    if (config.server.host !== "0.0.0.0" && config.server.host !== "::")
      hosts.add(config.server.host);
    this.staticHosts = hosts;
  }

  allowsHost(hostname: string): boolean {
    return (
      this.staticHosts.has(hostname) || this.externalAccess.hasHost(hostname)
    );
  }

  requiresWebAuth(req: Request): boolean {
    return this.isRemote(req) || this.config.auth.localWebAuth;
  }

  requiresMcpAuth(req: Request): boolean {
    return this.isRemote(req);
  }

  secureWebCookie(req: Request): boolean {
    const base = this.externalBaseUrl(req, "web");
    if (!base) return req.secure;
    return new URL(base).protocol === "https:";
  }

  expectedWebOrigin(req: Request): string | null {
    const base = this.externalBaseUrl(req, "web");
    return base ? new URL(base).origin : null;
  }

  webAuthnOrigin(req: Request): WebAuthnOrigin | null {
    const base = this.externalBaseUrl(req, "web");
    if (!base) return null;
    const url = new URL(base);
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1";
    if (url.protocol !== "https:" && !loopback) return null;
    return { origin: url.origin, rpId: url.hostname };
  }

  mcpBaseUrl(req: Request): string {
    const external = this.externalBaseUrl(req, "mcp");
    if (external) return external;
    return `${req.protocol}://${req.get("host") ?? `${this.config.server.host}:${this.config.server.port}`}`.replace(
      /\/$/,
      "",
    );
  }

  /** Requests routed through an external host or from a non-loopback peer. */
  private isRemote(req: Request): boolean {
    return this.externalAccess.hasHost(req.hostname) || !isLoopbackPeer(req);
  }

  private externalBaseUrl(
    req: Request,
    kind: ExternalAccessKind,
  ): string | null {
    return this.externalAccess.baseUrlForHost(kind, req.hostname);
  }
}

function isLoopbackPeer(req: Request): boolean {
  const address = req.socket.remoteAddress;
  return (
    address === "::1" ||
    address?.startsWith("127.") === true ||
    address?.startsWith("::ffff:127.") === true
  );
}
