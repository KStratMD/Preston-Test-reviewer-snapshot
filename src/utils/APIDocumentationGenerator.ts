import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../utils/Logger";
import fs from "fs/promises";
import path from "path";

export interface EndpointSpec {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  parameters?: ParameterSpec[];
  requestBody?: RequestBodySpec;
  responses?: ResponseSpec[];
  tags?: string[];
  security?: SecuritySpec[];
  deprecated?: boolean;
  examples?: ExampleSpec[];
}

export interface ParameterSpec {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  schema: SchemaSpec;
  description?: string;
  example?: unknown;
}

export interface RequestBodySpec {
  description?: string;
  required?: boolean;
  content: Record<string, {
      schema: SchemaSpec;
      example?: unknown;
    }>;
}

export interface ResponseSpec {
  statusCode: number;
  description: string;
  content?: Record<string, {
      schema: SchemaSpec;
      example?: unknown;
    }>;
  headers?: Record<string, {
      description?: string;
      schema: SchemaSpec;
    }>;
}

export interface SchemaSpec {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  format?: string;
  properties?: Record<string, SchemaSpec>;
  items?: SchemaSpec;
  required?: string[];
  example?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
}

export interface SecuritySpec {
  type: "apiKey" | "http" | "oauth2";
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  flows?: unknown;
}

export interface ExampleSpec {
  summary?: string;
  description?: string;
  value: unknown;
}

export interface APIDocumentationConfig {
  title: string;
  version: string;
  description?: string;
  baseUrl?: string;
  contact?: {
    name?: string;
    email?: string;
    url?: string;
  };
  license?: {
    name: string;
    url?: string;
  };
  servers?: {
    url: string;
    description?: string;
  }[];
}

export class APIDocumentationGenerator {
  private readonly endpoints = new Map<string, EndpointSpec>();
  private readonly config: APIDocumentationConfig;
  private readonly securitySchemes = new Map<string, SecuritySpec>();
  private readonly components = new Map<string, SchemaSpec>();

  constructor(config: APIDocumentationConfig) {
    this.config = config;
    this.setupDefaultSecurity();
  }

  private setupDefaultSecurity(): void {
    this.securitySchemes.set("bearerAuth", {
      type: "http",
      scheme: "bearer",
    });

    this.securitySchemes.set("apiKey", {
      type: "apiKey",
      name: "X-API-Key",
      in: "header",
    });
  }

  public addEndpoint(spec: EndpointSpec): void {
    const key = `${spec.method.toUpperCase()}:${spec.path}`;
    this.endpoints.set(key, spec);

    logger.debug("API endpoint documented", {
      method: spec.method,
      path: spec.path,
      summary: spec.summary,
    });
  }

  public addComponent(name: string, schema: SchemaSpec): void {
    this.components.set(name, schema);
  }

  public addSecurityScheme(name: string, scheme: SecuritySpec): void {
    this.securitySchemes.set(name, scheme);
  }

  // Middleware to automatically document endpoints
  public documentEndpoint(spec: Partial<EndpointSpec>) {
    return (req: Request, _res: Response, next: NextFunction) => {
      const endpointSpec: EndpointSpec = {
        path: req.route?.path || req.path,
        method: req.method.toLowerCase(),
        summary: spec.summary || `${req.method} ${req.route?.path || req.path}`,
        description: spec.description,
        parameters: spec.parameters || this.inferParameters(req),
        requestBody: spec.requestBody || this.inferRequestBody(req),
        responses: spec.responses || this.getDefaultResponses(),
        tags: spec.tags || [this.inferTag(req.path)],
        security: spec.security,
        deprecated: spec.deprecated || false,
        examples: spec.examples,
      };

      this.addEndpoint(endpointSpec);
      next();
    };
  }

  private inferParameters(req: Request): ParameterSpec[] {
    const parameters: ParameterSpec[] = [];

    // Path parameters
    if (req.params) {
      Object.keys(req.params).forEach(param => {
        parameters.push({
          name: param,
          in: "path",
          required: true,
          schema: { type: "string" },
          description: `Path parameter: ${param}`,
        });
      });
    }

    // Query parameters
    if (req.query) {
      Object.keys(req.query).forEach(param => {
        parameters.push({
          name: param,
          in: "query",
          required: false,
          schema: { type: "string" },
          description: `Query parameter: ${param}`,
          example: req.query[param],
        });
      });
    }

    return parameters;
  }

  private inferRequestBody(req: Request): RequestBodySpec | undefined {
    if (!req.body || req.method.toLowerCase() === "get") {
      return undefined;
    }

    return {
      description: "Request body",
      required: true,
      content: {
        "application/json": {
          schema: this.inferSchemaFromObject(req.body),
          example: req.body,
        },
      },
    };
  }

  private inferSchemaFromObject(obj: unknown): SchemaSpec {
    if (obj === null || obj === undefined) {
      return { type: "string" };
    }

    if (Array.isArray(obj)) {
      return {
        type: "array",
        items: obj.length > 0 ? this.inferSchemaFromObject(obj[0]) : { type: "string" },
      };
    }

    if (typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      const properties: Record<string, SchemaSpec> = {};
      const required: string[] = [];
      Object.keys(o).forEach(key => {
        const value = o[key];
        properties[key] = this.inferSchemaFromObject(value);
        if (value !== null && value !== undefined) required.push(key);
      });
      return { type: "object", properties, required: required.length ? required : undefined };
    }

    // Primitive types
    if (typeof obj === "string") {
      return { type: "string" };
    }
    if (typeof obj === "number") {
      return Number.isInteger(obj) ? { type: "integer" } : { type: "number" };
    }
    if (typeof obj === "boolean") {
      return { type: "boolean" };
    }

    return { type: "string" };
  }

  private getDefaultResponses(): ResponseSpec[] {
    return [
      {
        statusCode: 200,
        description: "Successful response",
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      },
      {
        statusCode: 400,
        description: "Bad request",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      {
        statusCode: 500,
        description: "Internal server error",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                error: { type: "string" },
                message: { type: "string" },
              },
            },
          },
        },
      },
    ];
  }

  private inferTag(path: string): string {
    const segments = path.split("/").filter(segment => segment && !segment.startsWith(":"));
    return segments[0] ?? "default";
  }

  // Generate OpenAPI 3.0 specification
  public generateOpenAPISpec(): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    const normalizeExpressPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

    // Group endpoints by path
    for (const [_key, endpoint] of this.endpoints) {
      const path = normalizeExpressPath(endpoint.path);

      if (!paths[path]) {
        paths[path] = {};
      }

      paths[path][endpoint.method.toLowerCase()] = {
        summary: endpoint.summary,
        description: endpoint.description,
        tags: endpoint.tags,
        parameters: endpoint.parameters?.map(param => ({
          name: param.name,
          in: param.in,
          required: param.required,
          schema: param.schema,
          description: param.description,
          example: param.example,
        })),
        requestBody: endpoint.requestBody,
        responses: this.formatResponses(endpoint.responses || []),
        security: endpoint.security,
        deprecated: endpoint.deprecated,
      };
    }

    return {
      openapi: "3.0.3",
      info: {
        title: this.config.title,
        version: this.config.version,
        description: this.config.description,
        contact: this.config.contact,
        license: this.config.license,
      },
      servers: this.config.servers || [
        {
          url: this.config.baseUrl || "http://localhost:3000",
          description: "Development server",
        },
      ],
      paths,
      components: {
        schemas: Object.fromEntries(this.components),
        securitySchemes: Object.fromEntries(this.securitySchemes),
      },
    };
  }

  private formatResponses(responses: ResponseSpec[]): Record<string, unknown> {
    const formatted: Record<string, unknown> = {};

    responses.forEach(response => {
      formatted[response.statusCode.toString()] = {
        description: response.description,
        content: response.content,
        headers: response.headers,
      };
    });

    return formatted;
  }

  // Generate Swagger UI HTML
  public generateSwaggerUI(swaggerUIPath = "/api-docs"): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.config.title} - API Documentation</title>
  <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui.css" />
  <style>
    html {
      box-sizing: border-box;
      overflow: -moz-scrollbars-vertical;
      overflow-y: scroll;
    }
    *, *:before, *:after {
      box-sizing: inherit;
    }
    body {
      margin:0;
      background: #fafafa;
    }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@4.15.5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      const ui = SwaggerUIBundle({
        url: '${swaggerUIPath}/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>`;
  }

  // Express router for serving documentation
  public createDocumentationRouter(basePath = "/api-docs"): Router {
    const router = Router();

    // Serve OpenAPI JSON
    router.get("/openapi.json", (_req, res) => {
      res.json(this.generateOpenAPISpec());
    });

    // Serve Swagger UI
    router.get("/", (_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.send(this.generateSwaggerUI(basePath));
    });

    // Health check endpoint
    router.get("/health", (_req, res) => {
      res.json({
        status: "healthy",
        endpoints: this.endpoints.size,
        components: this.components.size,
        lastUpdated: new Date().toISOString(),
      });
    });

    // Download OpenAPI spec as file
    router.get("/download", (_req, res) => {
      const spec = this.generateOpenAPISpec();
      const filename = `${this.config.title.replace(/\s+/g, "-").toLowerCase()}-api-spec.json`;

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.json(spec);
    });

    return router;
  }

  // Save documentation to files
  public async saveToFiles(outputDir: string): Promise<void> {
    try {
      await fs.mkdir(outputDir, { recursive: true });

      // Save OpenAPI spec
      const spec = this.generateOpenAPISpec();
      await fs.writeFile(
        path.join(outputDir, "openapi.json"),
        JSON.stringify(spec, null, 2),
      );

      // Save Swagger UI HTML
      const swaggerUI = this.generateSwaggerUI("./openapi.json");
      await fs.writeFile(
        path.join(outputDir, "index.html"),
        swaggerUI,
      );

      // Save Markdown documentation
      const markdown = this.generateMarkdownDocs();
      await fs.writeFile(
        path.join(outputDir, "API.md"),
        markdown,
      );

      logger.info("API documentation saved to files", {
        outputDir,
        endpoints: this.endpoints.size,
        components: this.components.size,
      });
    } catch (error) {
      logger.error("Failed to save API documentation", { error, outputDir });
      throw error;
    }
  }

  // Generate Markdown documentation
  public generateMarkdownDocs(): string {
    const header = (): string[] => {
      const h: string[] = [`# ${this.config.title} API Documentation`, ""];
      if (this.config.description) h.push(this.config.description, "");
      h.push(`**Version:** ${this.config.version}`, "");
      return h;
    };

    const groupEndpoints = (): Map<string, EndpointSpec[]> => {
      const map = new Map<string, EndpointSpec[]>();
      for (const ep of this.endpoints.values()) {
        const tag = ep.tags?.[0] || "default";
        if (!map.has(tag)) {
          map.set(tag, [ep]);
        } else {
          const arr = map.get(tag);
          if (arr) arr.push(ep);
        }
      }
      return map;
    };

    const renderEndpoint = (ep: EndpointSpec): string[] => {
      const out: string[] = [`### ${ep.method.toUpperCase()} ${ep.path}`, ""];
      if (ep.summary) out.push(ep.summary, "");
      if (ep.description) out.push(ep.description, "");
      if (ep.parameters?.length) {
        out.push("**Parameters:**", "", "| Name | Type | In | Required | Description |", "|------|------|----|---------:|-------------|");
        for (const p of ep.parameters) {
          out.push(`| ${p.name} | ${p.schema.type} | ${p.in} | ${p.required ? "Yes" : "No"} | ${p.description || ""} |`);
        }
        out.push("");
      }
      if (ep.responses?.length) {
        out.push("**Responses:**", "");
        for (const r of ep.responses) out.push(`- **${r.statusCode}**: ${r.description}`);
        out.push("");
      }
      out.push("---", "");
      return out;
    };

    const lines: string[] = [...header()];
    for (const [tag, endpoints] of groupEndpoints()) {
      lines.push(`## ${tag.charAt(0).toUpperCase() + tag.slice(1)}`, "");
      for (const ep of endpoints) lines.push(...renderEndpoint(ep));
    }
    return lines.join("\n");
  }

  public getStats() {
    return {
      endpoints: this.endpoints.size,
      components: this.components.size,
      securitySchemes: this.securitySchemes.size,
      tags: Array.from(new Set(
        Array.from(this.endpoints.values())
          .flatMap(endpoint => endpoint.tags || []),
      )),
    };
  }
}
