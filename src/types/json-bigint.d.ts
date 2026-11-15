declare module 'json-bigint' {
  interface JsonBigIntOptions {
    alwaysParseAsBig?: boolean;
    protoAction?: 'error' | 'ignore' | 'preserve';
    constructorAction?: 'error' | 'ignore' | 'preserve';
  }
  interface JsonBigIntParser {
    parse(text: string): unknown;
    stringify(value: unknown): string;
  }
  function createJsonBigInt(options?: JsonBigIntOptions): JsonBigIntParser;
  export = createJsonBigInt;
}
