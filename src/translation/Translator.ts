/**
 * Universal Translator
 * Translates between formats via canonical schemas
 */

import * as fs from 'fs';
import * as path from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Logger } from '../utils/Logger';
import type { CanonicalDocument, Parser, TranslationResult } from './types';
import { X12Parser } from './parsers/X12Parser';

export class UniversalTranslator {
  private parsers = new Map<string, Parser>();
  private ajv: Ajv;

  constructor(private logger: Logger) {
    this.ajv = new Ajv();
    addFormats(this.ajv);

    // Register parsers
    this.registerParser('x12', new X12Parser(logger));

    this.logger.info('Universal Translator initialized');
  }

  /**
   * Register a parser
   */
  registerParser(format: string, parser: Parser): void {
    this.parsers.set(format, parser);
    this.logger.debug(`Registered parser: ${format}`);
  }

  /**
   * Translate input to canonical format
   */
  async translateToCanonical(
    input: string | Buffer,
    format: 'x12' | 'csv' | 'cxml',
    documentType: 'order' | 'invoice' | 'item' | 'customer'
  ): Promise<CanonicalDocument> {
    // Get parser
    const parser = this.parsers.get(format);
    if (!parser) {
      throw new Error(`No parser registered for format: ${format}`);
    }

    // Validate input
    const isValid = await parser.validate(input);
    if (!isValid) {
      throw new Error(`Invalid ${format} format`);
    }

    // Parse input
    const rawData = await parser.parse(input);

    // Load canonical schema
    const schema = this.loadCanonicalSchema(documentType);

    // Map to canonical format
    const canonical = this.mapToCanonical(rawData, documentType);

    // Validate against schema
    this.validateCanonical(canonical, schema);

    return {
      type: documentType,
      data: canonical,
      metadata: {
        sourceFormat: format,
        translatedAt: new Date().toISOString(),
        version: '1.0'
      }
    };
  }

  /**
   * Translate from canonical to target system
   */
  async translateFromCanonical(
    canonical: CanonicalDocument,
    targetSystem: string
  ): Promise<TranslationResult> {
    // For MVP, implement simple NetSuite Sales Order transformation
    if (targetSystem === 'netsuite' && canonical.type === 'order') {
      const targetPayload = {
        entity: (canonical.data as any).customer.customerId,
        tranDate: (canonical.data as any).orderDate,
        otherRefNum: (canonical.data as any).orderId,
        item: (canonical.data as any).lineItems.map((line: { itemId: string; quantity: number; unitPrice: number }) => ({
          item: line.itemId,
          quantity: line.quantity,
          rate: line.unitPrice,
          amount: line.quantity * line.unitPrice
        }))
      };

      return {
        canonical,
        targetPayload,
        mappings: [
          { canonicalField: 'customer.customerId', targetField: 'entity' },
          { canonicalField: 'orderDate', targetField: 'tranDate' },
          { canonicalField: 'orderId', targetField: 'otherRefNum' },
          { canonicalField: 'lineItems[].itemId', targetField: 'item[].item' }
        ],
        warnings: [],
        errors: []
      };
    }

    throw new Error(`Translation to ${targetSystem} not yet implemented for ${canonical.type}`);
  }

  /**
   * Load canonical schema
   */
  private loadCanonicalSchema(documentType: string): unknown {
    const schemaPath = path.join(__dirname, 'canonical', `${documentType}.schema.json`);

    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Canonical schema not found: ${documentType}`);
    }

    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
    return schema;
  }

  /**
   * Map raw data to canonical format
   */
  private mapToCanonical(rawData: unknown, documentType: string): unknown {
    // For MVP, assume rawData is already close to canonical
    // In production, this would use AI field mapping
    return rawData;
  }

  /**
   * Validate canonical document against schema
   */
  private validateCanonical(data: unknown, schema: unknown): void {
    const validate = this.ajv.compile(schema);
    const valid = validate(data);

    if (!valid) {
      const errors = validate.errors?.map(e => `${e.instancePath}: ${e.message}`).join(', ');
      throw new Error(`Canonical validation failed: ${errors}`);
    }

    this.logger.debug('Canonical document validated successfully');
  }
}
