import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Blocked URL ${url}: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

export async function assertNotSsrf(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, "invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError(url, "only http and https URLs are allowed");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isPrivateIp(hostname)) {
    throw new SsrfBlockedError(url, `private address ${hostname}`);
  }

  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  for (const address of addresses) {
    if (isPrivateIp(address.address)) {
      throw new SsrfBlockedError(url, `private address ${address.address}`);
    }
  }
}

function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }

  return hostname;
}

export function isPrivateIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  const family = isIP(normalized);

  if (family === 4) {
    return isPrivateIpv4(normalized);
  }

  if (family === 6) {
    return isPrivateIpv6(normalized);
  }

  return false;
}

function normalizeIp(ip: string): string {
  const lower = ip.toLowerCase();

  const mappedDotted = lower.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/,
  );
  if (mappedDotted) {
    return mappedDotted[1] ?? lower;
  }

  const mappedHex = lower.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1] ?? "", 16);
    const low = Number.parseInt(mappedHex[2] ?? "", 16);
    if (Number.isInteger(high) && Number.isInteger(low)) {
      return [
        (high >> 8) & 0xff,
        high & 0xff,
        (low >> 8) & 0xff,
        low & 0xff,
      ].join(".");
    }
  }

  return lower;
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }

  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isPrivateIpv6(ip: string): boolean {
  return (
    ip === "::" ||
    ip === "::1" ||
    ip.startsWith("fc") ||
    ip.startsWith("fd") ||
    ip.startsWith("fe8") ||
    ip.startsWith("fe9") ||
    ip.startsWith("fea") ||
    ip.startsWith("feb") ||
    ip.startsWith("fec") ||
    ip.startsWith("fed") ||
    ip.startsWith("fee") ||
    ip.startsWith("fef")
  );
}
