/**
 * Embedded platform adapter descriptor — typed shape every PR-10b adapter
 * must satisfy.
 *
 * `hostBootstrap.method` is a literal `'server_to_server'` to make the
 * "no browser-side bearer token" invariant a compile-time guarantee, not
 * a runtime check the type system can lose. The runtime
 * `assertEmbeddedPlatformAdapter()` still catches non-empty-artifact and
 * non-empty-module-list invariants that can't be expressed in the type.
 */
import type { EmbeddedModule, EmbeddedPlatform } from '../contract/EmbeddedSurfaceContract';

export interface EmbeddedPlatformAdapter {
  id: string;
  platform: Exclude<EmbeddedPlatform, 'standalone'>;
  displayName: string;
  artifactPaths: string[];
  hostBootstrap: {
    method: 'server_to_server';
    browserBearerExposed: false;
    platformApi: string;
  };
  supportedModules: EmbeddedModule[];
  requiredConfigKeys: string[];
}

export function assertEmbeddedPlatformAdapter(adapter: EmbeddedPlatformAdapter): void {
  const id = (adapter && typeof adapter.id === 'string') ? adapter.id : '<unknown>';
  if (!adapter || typeof adapter !== 'object') {
    throw new Error('assertEmbeddedPlatformAdapter requires a descriptor object');
  }
  // Callers that cast incomplete shapes through `as any` reach here without a
  // hostBootstrap. Guard before reading nested fields so we throw a meaningful
  // error instead of a TypeError on `.method` of undefined.
  if (!adapter.hostBootstrap || typeof adapter.hostBootstrap !== 'object') {
    throw new Error(
      `Embedded adapter ${id} must declare a hostBootstrap descriptor`,
    );
  }
  if (
    adapter.hostBootstrap.method !== 'server_to_server' ||
    adapter.hostBootstrap.browserBearerExposed !== false
  ) {
    throw new Error(
      `Embedded adapter ${id} must call host-bootstrap server-to-server and never expose bearer tokens to browser JavaScript`,
    );
  }
  if (!Array.isArray(adapter.artifactPaths) || adapter.artifactPaths.length === 0) {
    throw new Error(
      `Embedded adapter ${id} must declare at least one platform artifact`,
    );
  }
  if (!Array.isArray(adapter.supportedModules) || adapter.supportedModules.length === 0) {
    throw new Error(
      `Embedded adapter ${id} must declare at least one supported module`,
    );
  }
}
