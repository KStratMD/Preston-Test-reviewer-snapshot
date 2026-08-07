export interface Shutdownable {
  shutdown?: () => Promise<void>;
}

declare global {
  // Provided by globalSetup
  var __APP__: ReturnType<import('../src/app').App['getExpressApp']>;
  var __APP_INSTANCE__: Shutdownable;
}

export {};
