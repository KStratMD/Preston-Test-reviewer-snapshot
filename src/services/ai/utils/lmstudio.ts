import { readFileSync } from 'node:fs';
import { release as osRelease } from 'node:os';

const DEFAULT_LMSTUDIO_PORT = 1234;
const DEFAULT_LMSTUDIO_BASE_URL = `http://127.0.0.1:${DEFAULT_LMSTUDIO_PORT}`;

function normalizeBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/, '');
}

function isWslEnvironment(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) {
    return true;
  }

  return /microsoft/i.test(osRelease());
}

function parseWslGatewayIp(routeTable: string): string | undefined {
  for (const line of routeTable.split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 3) {
      continue;
    }

    const [, destination, gateway] = columns;
    if (destination !== '00000000' || gateway === '00000000') {
      continue;
    }

    const octets = gateway.match(/../g)?.map((part) => Number.parseInt(part, 16));
    if (!octets || octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
      continue;
    }

    return octets.reverse().join('.');
  }

  return undefined;
}

function readWslGatewayIp(): string | undefined {
  if (!isWslEnvironment()) {
    return undefined;
  }

  try {
    const routeTable = readFileSync('/proc/net/route', 'utf8');
    return parseWslGatewayIp(routeTable);
  } catch {
    return undefined;
  }
}

export function resolveLMStudioBaseUrl(rawBaseUrl?: string): string {
  // Whitespace-only values must fall through to the defaults — normalizing
  // them to '' would otherwise produce invalid requests like '/v1/models'.
  const normalized = rawBaseUrl ? normalizeBaseUrl(rawBaseUrl) : '';
  if (normalized) {
    return normalized;
  }

  const gatewayIp = readWslGatewayIp();
  return gatewayIp ? `http://${gatewayIp}:${DEFAULT_LMSTUDIO_PORT}` : DEFAULT_LMSTUDIO_BASE_URL;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Resolve like resolveLMStudioBaseUrl, but additionally repair SAVED loopback
 * endpoints under WSL (NAT mode): rows persisted before the WSL-aware resolver
 * commonly hold http://127.0.0.1:1234, which from WSL reaches WSL's own
 * loopback — never the Windows-side LM Studio. When a gateway IP is derivable,
 * loopback hosts are swapped for it (port/path preserved). Outside WSL — or in
 * mirrored-networking mode, where no NAT gateway exists and loopback IS the
 * Windows host — values pass through unchanged. Use for DB/saved values only;
 * operator-pinned env values should go through resolveLMStudioBaseUrl so an
 * explicit choice is never rewritten.
 */
export function canonicalizeLMStudioBaseUrl(rawBaseUrl?: string): string {
  const resolved = resolveLMStudioBaseUrl(rawBaseUrl);
  try {
    const url = new URL(resolved);
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
      // Non-loopback hosts never need repair — skip the /proc read entirely.
      return resolved;
    }
    const gatewayIp = readWslGatewayIp();
    if (!gatewayIp) {
      return resolved;
    }
    url.hostname = gatewayIp;
    if (!url.port) {
      // A saved bare-loopback URL (http://localhost) has an empty port after
      // parsing; without this the host swap would default to port 80 instead
      // of LM Studio's 1234.
      url.port = String(DEFAULT_LMSTUDIO_PORT);
    }
    return normalizeBaseUrl(url.toString());
  } catch {
    // Not URL-parseable — return the resolved value unchanged.
    return resolved;
  }
}

