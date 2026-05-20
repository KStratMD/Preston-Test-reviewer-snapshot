/**
 * Wraps an IConnector with DemoConnectorDecorator behind a Proxy.
 *
 * The Proxy forwards `has`/`get` checks to the inner connector in non-demo
 * mode so route guards like `'getOrderByNumber' in connector` work correctly
 * for connector-specific methods. In demo mode, only the decorator's own
 * IConnector methods are exposed.
 *
 * Extracted from inversify.config.ts so it can be tested independently
 * without triggering DI container side effects.
 */

import type { IConnector } from '../interfaces/IConnector';
import type { Logger } from '../utils/Logger';
import { DemoConnectorDecorator } from './DemoConnectorDecorator';
import { isDemoMode } from '../config/runtimeFlags';

export function wrapWithDecorator(connector: IConnector, logger: Logger): IConnector {
  const decorator = new DemoConnectorDecorator(connector, logger);

  return new Proxy(decorator, {
    has(_target, prop) {
      if (Reflect.has(decorator, prop)) return true;
      // Non-demo: expose inner connector's specific methods (e.g. getOrderByNumber)
      if (!isDemoMode()) return Reflect.has(connector, prop);
      return false;
    },
    get(_target, prop, _receiver) {
      // Decorator's own properties/methods take priority
      if (Reflect.has(decorator, prop)) {
        const val = Reflect.get(decorator, prop, decorator);
        return typeof val === 'function' ? val.bind(decorator) : val;
      }
      // Non-demo: forward connector-specific methods to the real connector
      if (!isDemoMode()) {
        const val = Reflect.get(connector, prop, connector);
        return typeof val === 'function' ? val.bind(connector) : val;
      }
      return undefined;
    },
  }) as IConnector;
}
