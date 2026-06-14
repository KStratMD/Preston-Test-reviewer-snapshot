/**
 * Universal Translation Types
 */

export interface CanonicalDocument {
  type: 'order' | 'invoice' | 'item' | 'customer';
  data: unknown;
  metadata: {
    sourceFormat: string;
    sourceSystem?: string;
    translatedAt: string;
    version: string;
  };
}

export interface Parser {
  name: string;
  format: 'x12' | 'csv' | 'cxml' | 'json' | 'xml';
  parse(input: string | Buffer): Promise<unknown>;
  validate(input: string | Buffer): Promise<boolean>;
}

export interface TranslationResult {
  canonical: CanonicalDocument;
  targetPayload: unknown;
  mappings: {
    canonicalField: string;
    targetField: string;
    transformation?: string;
  }[];
  warnings: string[];
  errors: string[];
}
