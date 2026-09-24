declare module 'swagger-jsdoc' {
  export interface Options {
    definition: Record<string, unknown>;
    apis: string[];
    /**
     * Defaults to false inside swagger-jsdoc, which prints a report to stdout
     * and returns a spec with the unparseable block silently missing. Always
     * pass true: a dropped route is indistinguishable from an undocumented one.
     */
    failOnErrors?: boolean;
  }
  export default function swaggerJSDoc(options: Options): Record<string, unknown>;
}
