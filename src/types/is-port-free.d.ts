declare module 'is-port-free' {
  function isPortFree(port: number): Promise<boolean>;
  export = isPortFree;
}