/**
 * X12 EDI Parser (850 Purchase Order)
 * Simplified implementation for MVP
 */

import type { Parser } from '../types';
import type { Logger } from '../../utils/Logger';

export class X12Parser implements Parser {
  name = 'X12 Parser';
  format: 'x12' = 'x12';

  constructor(private logger: Logger) {}

  /**
   * Parse X12 850 (Purchase Order) to JSON
   */
  async parse(input: string | Buffer): Promise<unknown> {
    const content = typeof input === 'string' ? input : input.toString('utf-8');

    // X12 segments are terminated by ~ (tilde)
    const segments = content.split('~').map(s => s.trim()).filter(s => s.length > 0);

    const order: unknown = {
      orderId: '',
      orderDate: '',
      customer: {},
      lineItems: []
    };

    // Parse segments
    for (const segment of segments) {
      const elements = segment.split('*');
      const segmentId = elements[0];

      switch (segmentId) {
        case 'BEG': // Beginning Segment for Purchase Order
          (order as any).orderId = elements[3];  // Purchase Order Number
          (order as any).orderDate = this.parseX12Date(elements[5]); // PO Date
          break;

        case 'N1': // Name
          if (elements[1] === 'BY') { // Buyer
            (order as any).customer.name = elements[2];
          }
          break;

        case 'PO1': // Baseline Item Data
          (order as any).lineItems.push({
            lineNumber: parseInt(elements[1]),
            quantity: parseFloat(elements[2]),
            uom: elements[3],
            unitPrice: parseFloat(elements[4]),
            itemId: elements[7]
          });
          break;
      }
    }

    this.logger.debug('Parsed X12 850', { orderId: (order as any).orderId, lineItemCount: (order as any).lineItems.length });

    return order;
  }

  /**
   * Validate X12 format
   */
  async validate(input: string | Buffer): Promise<boolean> {
    const content = typeof input === 'string' ? input : input.toString('utf-8');

    // Basic validation: check for ISA header and segment terminators
    return content.includes('ISA*') && content.includes('~');
  }

  /**
   * Parse X12 date format (YYMMDD or CCYYMMDD)
   */
  private parseX12Date(dateStr: string): string {
    if (!dateStr) return new Date().toISOString();

    if (dateStr.length === 8) {
      // CCYYMMDD
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      return `${year}-${month}-${day}T00:00:00.000Z`;
    } else if (dateStr.length === 6) {
      // YYMMDD
      const year = '20' + dateStr.substring(0, 2);
      const month = dateStr.substring(2, 4);
      const day = dateStr.substring(4, 6);
      return `${year}-${month}-${day}T00:00:00.000Z`;
    }

    return new Date().toISOString();
  }
}
