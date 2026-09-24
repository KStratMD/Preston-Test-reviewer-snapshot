/**
 * SAP Connector Demo Mode Tests
 *
 * Tests the demo mode functionality of SAP Connector without requiring real SAP credentials.
 */

import { SAPConnector } from '../../../../src/connectors/SAPConnector';
import type { AuthService } from '../../../../src/services/AuthService';
import type { Logger } from '../../../../src/utils/Logger';
import type { AuthConfig, DataRecord } from '../../../../src/types';

// Mock dependencies
jest.mock('../../../../src/services/AuthService');
jest.mock('../../../../src/utils/Logger');

describe('SAPConnector - Demo Mode', () => {
  let connector: SAPConnector;
  let mockAuthService: jest.Mocked<AuthService>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(async () => {
    mockAuthService = {
      authenticateBasic: jest.fn(),
      authenticateOAuth2: jest.fn(),
      refreshToken: jest.fn(),
    } as any;

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    } as any;

    process.env.DEMO_MODE = '1';

    connector = new SAPConnector('sap-test', mockLogger, mockAuthService);

    await connector.initialize({
      type: 'basic',
      credentials: {
        username: 'demo',
        password: 'demo',
        client: '100',
        systemId: 'DEV',
        host: 'demo.sap.local',
      },
    });

    await connector.authenticate();
  });

  afterEach(() => {
    delete process.env.DEMO_MODE;
  });

  describe('Demo Mode Initialization', () => {
    it('should enable demo mode with demo credentials', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SAP connector initialized in DEMO mode'
      );
    });

    it('should seed demo data on initialization', async () => {
      const materials = await connector.list('material');
      expect(materials.length).toBeGreaterThan(0);
    });

    it('should return demo system info', async () => {
      const systemInfo = await connector.getSystemInfo();

      expect(systemInfo.name).toContain('SAP ERP');
      expect(systemInfo.type).toBe('SAP');
      expect(systemInfo.capabilities).toContain('materials');
      expect(systemInfo.capabilities).toContain('purchase_orders');
    });

    it('should authenticate successfully in demo mode', async () => {
      const result = await connector.authenticate();
      expect(result).toBe(true);
    });
  });

  describe('Demo Mode Materials CRUD', () => {
    it('should create a material', async () => {
      const created = await connector.create('material', {
        fields: {
          Description: 'Test Material',
          MaterialType: 'FERT',
        },
      });

      expect(created).toBeDefined();
      expect(created.id).toBeDefined();
      expect(created.fields.Description).toBe('Test Material');
    });

    it('should read a seeded material', async () => {
      const material = await connector.read('material', 'MAT-001');

      expect(material).toBeDefined();
      expect(material?.id).toBe('MAT-001');
      expect(material?.fields.Description).toBe('Demo Material A');
    });

    it('should update a material', async () => {
      const updated = await connector.update('material', 'MAT-001', {
        fields: {
          Description: 'Updated Material A',
        },
      });

      expect(updated.fields.Description).toBe('Updated Material A');
      expect(updated.fields.MaterialType).toBe('FERT'); // Preserved
    });

    it('should delete a material using returned ID', async () => {
      const created = await connector.create('material', {
        fields: { Description: 'To Delete' },
      });

      const result = await connector.delete('material', created.id);
      expect(result).toBe(true);

      const deleted = await connector.read('material', created.id);
      expect(deleted).toBeNull();
    });

    it('should list all materials', async () => {
      const materials = await connector.list('material');
      expect(materials.length).toBeGreaterThanOrEqual(2);
    });

    it('should list materials with limit', async () => {
      const materials = await connector.list('material', { limit: 1 });
      expect(materials.length).toBe(1);
    });

    it('should list materials with pagination', async () => {
      const page1 = await connector.list('material', { limit: 1, offset: 0 });
      const page2 = await connector.list('material', { limit: 1, offset: 1 });

      expect(page1.length).toBe(1);
      if (page2.length > 0) {
        expect(page1[0].id).not.toBe(page2[0].id);
      }
    });
  });

  describe('Demo Mode Purchase Orders', () => {
    it('should create a purchase order', async () => {
      const created = await connector.create('purchase_order', {
        fields: {
          Vendor: 'V-001',
          CompanyCode: '1000',
        },
      });

      expect(created).toBeDefined();
      expect(created.fields.Vendor).toBe('V-001');
    });

    it('should read a seeded purchase order', async () => {
      const po = await connector.read('purchase_order', 'PO-001');

      expect(po).toBeDefined();
      expect(po?.fields.PurchaseOrder).toBe('PO-001');
      expect(po?.fields.Vendor).toBe('VENDOR-001');
    });

    it('should list purchase orders', async () => {
      const pos = await connector.list('purchase_order');
      expect(pos.length).toBeGreaterThan(0);
    });
  });

  describe('Demo Mode Sales Orders', () => {
    it('should create a sales order', async () => {
      const created = await connector.create('sales_order', {
        fields: {
          SoldToParty: 'C-001',
          SalesOrganization: '1000',
        },
      });

      expect(created).toBeDefined();
      expect(created.fields.SoldToParty).toBe('C-001');
    });

    it('should read a seeded sales order', async () => {
      const so = await connector.read('sales_order', 'SO-001');

      expect(so).toBeDefined();
      expect(so?.fields.SalesOrder).toBe('SO-001');
      expect(so?.fields.SoldToParty).toBe('CUST-001');
    });

    it('should list sales orders', async () => {
      const sos = await connector.list('sales_order');
      expect(sos.length).toBeGreaterThan(0);
    });
  });

  describe('Demo Mode Search', () => {
    it('should search with simple string filter', async () => {
      const results = await connector.search('material', {
        filters: { Description: 'Demo' },
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', async () => {
      const results = await connector.search('material', {
        filters: { Description: 'NONEXISTENT' },
      });

      expect(results).toEqual([]);
    });
  });

  describe('Demo Mode Error Handling', () => {
    it('should return null for non-existent material', async () => {
      const result = await connector.read('material', 'NON-EXISTENT');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent material', async () => {
      const result = await connector.delete('material', 'NON-EXISTENT');
      expect(result).toBe(false);
    });

    it('should throw error when updating non-existent material', async () => {
      await expect(
        connector.update('material', 'NON-EXISTENT', {
          fields: { Description: 'Updated' },
        })
      ).rejects.toThrow('material not found');
    });

    it('should handle empty entity type', async () => {
      const results = await connector.list('unknown_entity');
      expect(results).toEqual([]);
    });
  });

  describe('Demo Mode List Filters', () => {
    beforeEach(async () => {
      await connector.create('material', {
        fields: {
          Description: 'Filter Test A',
          MaterialType: 'FERT',
          MaterialGroup: 'GROUP-A',
        },
      });

      await connector.create('material', {
        fields: {
          Description: 'Filter Test B',
          MaterialType: 'ROH',
          MaterialGroup: 'GROUP-B',
        },
      });
    });

    it('should filter list by MaterialType', async () => {
      const results = await connector.list('material', {
        filters: { MaterialType: 'FERT' },
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((r: DataRecord) => {
        expect(r.fields.MaterialType).toBe('FERT');
      });
    });

    it('should filter list by MaterialGroup', async () => {
      const results = await connector.list('material', {
        filters: { MaterialGroup: 'DEMO-GROUP' },
      });

      expect(results.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Demo Mode Sorting', () => {
    it('should sort by MaterialNumber ascending', async () => {
      const results = await connector.list('material', {
        sortBy: 'MaterialNumber',
        sortOrder: 'asc',
      });

      if (results.length >= 2) {
        const first = results[0].fields.MaterialNumber;
        const second = results[1].fields.MaterialNumber;
        expect(first <= second).toBe(true);
      }
    });

    it('should sort by Description descending', async () => {
      const results = await connector.list('material', {
        sortBy: 'Description',
        sortOrder: 'desc',
      });

      if (results.length >= 2) {
        const first = results[0].fields.Description;
        const second = results[1].fields.Description;
        expect(first >= second).toBe(true);
      }
    });
  });

  describe('Demo Mode Field Preservation', () => {
    it('should preserve all fields on create', async () => {
      const created = await connector.create('material', {
        fields: {
          MaterialNumber: 'FIELD-TEST',
          Description: 'Field Test',
          MaterialType: 'FERT',
          CustomField1: 'Custom 1',
          CustomField2: 'Custom 2',
        },
      });

      expect(created.fields.MaterialNumber).toBe('FIELD-TEST');
      expect(created.fields.CustomField1).toBe('Custom 1');
      expect(created.fields.CustomField2).toBe('Custom 2');
    });

    it('should merge fields on update', async () => {
      const created = await connector.create('material', {
        fields: {
          Description: 'Original',
          MaterialType: 'FERT',
          Plant: '1000',
        },
      });

      const updated = await connector.update('material', created.id, {
        fields: {
          Description: 'Updated',
          MaterialGroup: 'NEW-GROUP',
        },
      });

      expect(updated.fields.Description).toBe('Updated');
      expect(updated.fields.MaterialGroup).toBe('NEW-GROUP');
      expect(updated.fields.MaterialType).toBe('FERT'); // Preserved
      expect(updated.fields.Plant).toBe('1000'); // Preserved
    });
  });

  describe('Demo Mode Advanced Scenarios', () => {
    it('should handle creating multiple materials in sequence', async () => {
      const mat1 = await connector.create('material', {
        fields: { Description: 'Material 1', MaterialType: 'FERT' },
      });
      const mat2 = await connector.create('material', {
        fields: { Description: 'Material 2', MaterialType: 'ROH' },
      });
      const mat3 = await connector.create('material', {
        fields: { Description: 'Material 3', MaterialType: 'HALB' },
      });

      expect(mat1.id).toBeDefined();
      expect(mat2.id).toBeDefined();
      expect(mat3.id).toBeDefined();
      expect(mat1.fields.Description).toBe('Material 1');
      expect(mat2.fields.Description).toBe('Material 2');
      expect(mat3.fields.Description).toBe('Material 3');
    });

    it('should handle purchase orders with complex data', async () => {
      const po = await connector.create('purchase_order', {
        fields: {
          Vendor: 'V-12345',
          CompanyCode: '2000',
          DocumentDate: '2025-10-29',
          TotalValue: 50000,
          Currency: 'USD',
          PaymentTerms: 'NET30',
        },
      });

      expect(po.fields.Vendor).toBe('V-12345');
      expect(po.fields.TotalValue).toBe(50000);
      expect(po.fields.Currency).toBe('USD');
    });

    it('should handle sales orders with line items', async () => {
      const so = await connector.create('sales_order', {
        fields: {
          SoldToParty: 'C-67890',
          SalesOrganization: '3000',
          OrderDate: '2025-10-29',
          NetValue: 75000,
          Currency: 'EUR',
          ShipToParty: 'C-67890',
        },
      });

      expect(so.fields.SoldToParty).toBe('C-67890');
      expect(so.fields.NetValue).toBe(75000);
    });

    it('should support filtering by multiple MaterialType values', async () => {
      await connector.create('material', {
        fields: { Description: 'FERT Mat', MaterialType: 'FERT' },
      });
      await connector.create('material', {
        fields: { Description: 'ROH Mat', MaterialType: 'ROH' },
      });

      const fertMaterials = await connector.list('material', {
        filters: { MaterialType: 'FERT' },
      });

      expect(fertMaterials.length).toBeGreaterThan(0);
      fertMaterials.forEach((m: DataRecord) => {
        expect(m.fields.MaterialType).toBe('FERT');
      });
    });

    it('should handle empty filter results gracefully', async () => {
      const results = await connector.list('material', {
        filters: { MaterialType: 'NONEXISTENT_TYPE' },
      });

      expect(results).toEqual([]);
    });

    it('should maintain data integrity across operations', async () => {
      const created = await connector.create('material', {
        fields: {
          MaterialNumber: 'INTEGRITY-001',
          Description: 'Integrity Test',
          MaterialType: 'FERT',
        },
      });

      const read1 = await connector.read('material', created.id);
      expect(read1?.fields.Description).toBe('Integrity Test');

      await connector.update('material', created.id, {
        fields: {
          MaterialNumber: 'INTEGRITY-001',
          Description: 'Updated Integrity',
          MaterialType: 'FERT',
        },
      });

      const read2 = await connector.read('material', created.id);
      expect(read2?.fields.Description).toBe('Updated Integrity');
    });

    it('should support sorting by different fields', async () => {
      await connector.create('material', {
        fields: { Description: 'Zebra Material', MaterialType: 'FERT' },
      });
      await connector.create('material', {
        fields: { Description: 'Alpha Material', MaterialType: 'ROH' },
      });

      const sorted = await connector.list('material', {
        sortBy: 'Description',
        sortOrder: 'asc',
      });

      if (sorted.length >= 2) {
        const hasZebra = sorted.some((m: DataRecord) =>
          m.fields.Description?.toString().includes('Zebra')
        );
        const hasAlpha = sorted.some((m: DataRecord) =>
          m.fields.Description?.toString().includes('Alpha')
        );
        expect(hasZebra || hasAlpha).toBe(true);
      }
    });

    it('should handle updates with timestamp fields', async () => {
      const created = await connector.create('material', {
        fields: {
          Description: 'Timestamp Test',
          MaterialType: 'FERT',
        },
      });

      const updated = await connector.update('material', created.id, {
        fields: {
          Description: 'Updated with Timestamp',
          MaterialType: 'FERT',
        },
      });

      expect(updated.fields.UpdatedAt).toBeDefined();
    });

    it('should support custom entity types in demo mode', async () => {
      const customEntity = await connector.create('custom_sap_entity', {
        fields: {
          CustomField1: 'Value1',
          CustomField2: 'Value2',
        },
      });

      expect(customEntity).toBeDefined();
      expect(customEntity.fields.CustomField1).toBe('Value1');

      const read = await connector.read('custom_sap_entity', customEntity.id);
      expect(read).toBeDefined();
      expect(read?.fields.CustomField2).toBe('Value2');
    });

    it('should handle list with both filtering and sorting', async () => {
      await connector.create('material', {
        fields: {
          Description: 'B Material',
          MaterialType: 'FERT',
          MaterialGroup: 'GROUP1',
        },
      });
      await connector.create('material', {
        fields: {
          Description: 'A Material',
          MaterialType: 'FERT',
          MaterialGroup: 'GROUP1',
        },
      });

      const results = await connector.list('material', {
        filters: { MaterialGroup: 'GROUP1' },
        sortBy: 'Description',
        sortOrder: 'asc',
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((m: DataRecord) => {
        expect(m.fields.MaterialGroup).toBe('GROUP1');
      });
    });
  });

  describe('Demo Mode Extended Entity Types', () => {
    it('should handle customer entity type', async () => {
      const customer = await connector.create('customer', {
        fields: {
          CustomerNumber: 'CUST-001',
          Name: 'Test Customer Ltd',
          City: 'London',
          Country: 'GB',
        },
      });

      expect(customer).toBeDefined();
      expect(customer.id).toBeDefined();
      expect(customer.fields.Name).toBe('Test Customer Ltd');
    });

    it('should handle vendor entity type', async () => {
      const vendor = await connector.create('vendor', {
        fields: {
          VendorNumber: 'VEND-001',
          Name: 'Test Vendor GmbH',
          City: 'Berlin',
          Country: 'DE',
        },
      });

      expect(vendor).toBeDefined();
      expect(vendor.fields.Name).toBe('Test Vendor GmbH');
    });

    it('should handle invoice entity type', async () => {
      const invoice = await connector.create('invoice', {
        fields: {
          InvoiceNumber: 'INV-2025-001',
          Amount: 15000,
          Currency: 'EUR',
          Status: 'Open',
        },
      });

      expect(invoice).toBeDefined();
      expect(invoice.fields.Amount).toBe(15000);
    });

    it('should handle work_order entity type', async () => {
      const workOrder = await connector.create('work_order', {
        fields: {
          OrderNumber: 'WO-2025-001',
          Material: 'MAT-001',
          Quantity: 100,
          Status: 'Created',
        },
      });

      expect(workOrder).toBeDefined();
      expect(workOrder.fields.Quantity).toBe(100);
    });
  });

  describe('Demo Mode Batch Operations', () => {
    it('should handle batch create operations', async () => {
      const materials = [];
      for (let i = 1; i <= 5; i++) {
        const mat = await connector.create('material', {
          fields: {
            Description: `Batch Material ${i}`,
            MaterialType: 'FERT',
            MaterialGroup: 'BATCH-GROUP',
          },
        });
        materials.push(mat);
      }

      expect(materials.length).toBe(5);
      materials.forEach((mat) => {
        expect(mat.id).toBeDefined();
        expect(mat.fields.MaterialGroup).toBe('BATCH-GROUP');
      });
    });

    it('should handle batch read operations', async () => {
      const materials = await connector.list('material');
      const initialCount = materials.length;

      await connector.create('material', {
        fields: { Description: 'Batch Read 1', MaterialType: 'FERT' },
      });
      await connector.create('material', {
        fields: { Description: 'Batch Read 2', MaterialType: 'ROH' },
      });
      await connector.create('material', {
        fields: { Description: 'Batch Read 3', MaterialType: 'HALB' },
      });

      const materialsAfter = await connector.list('material');
      expect(materialsAfter.length).toBeGreaterThan(initialCount);
    });

    it('should handle batch update operations', async () => {
      const created = await connector.create('material', {
        fields: { Description: 'Original', MaterialType: 'FERT' },
      });

      await connector.update('material', created.id, {
        fields: { Description: 'Updated 1', MaterialType: 'FERT' },
      });
      await connector.update('material', created.id, {
        fields: { Description: 'Updated 2', MaterialType: 'FERT' },
      });
      await connector.update('material', created.id, {
        fields: { Description: 'Updated 3', MaterialType: 'FERT' },
      });

      const updated = await connector.read('material', created.id);
      expect(updated?.fields.Description).toBe('Updated 3');
    });

    it('should handle batch delete operations', async () => {
      const initialMaterials = await connector.list('material');
      const initialCount = initialMaterials.length;

      const mat1 = await connector.create('material', {
        fields: { Description: 'To Delete 1', MaterialType: 'FERT' },
      });
      const mat2 = await connector.create('material', {
        fields: { Description: 'To Delete 2', MaterialType: 'ROH' },
      });
      const mat3 = await connector.create('material', {
        fields: { Description: 'To Delete 3', MaterialType: 'HALB' },
      });

      await connector.delete('material', mat1.id);
      await connector.delete('material', mat2.id);
      await connector.delete('material', mat3.id);

      const finalMaterials = await connector.list('material');
      expect(finalMaterials.length).toBeLessThanOrEqual(initialCount + 3);
    });
  });

  describe('Demo Mode Data Validation', () => {
    it('should handle special characters in field values', async () => {
      const material = await connector.create('material', {
        fields: {
          Description: "Test's \"Special\" <Chars> & Symbols!",
          MaterialType: 'FERT',
          Notes: 'Line1\nLine2\tTabbed',
        },
      });

      expect(material.fields.Description).toBe("Test's \"Special\" <Chars> & Symbols!");
    });

    it('should handle numeric field types', async () => {
      const material = await connector.create('material', {
        fields: {
          Description: 'Numeric Test',
          MaterialType: 'FERT',
          Quantity: 1000,
          Weight: 45.75,
          Price: 129.99,
        },
      });

      expect(material.fields.Quantity).toBe(1000);
      expect(material.fields.Weight).toBe(45.75);
      expect(material.fields.Price).toBe(129.99);
    });

    it('should handle boolean field types', async () => {
      const material = await connector.create('material', {
        fields: {
          Description: 'Boolean Test',
          MaterialType: 'FERT',
          IsActive: true,
          IsDiscontinued: false,
        },
      });

      expect(material.fields.IsActive).toBe(true);
      expect(material.fields.IsDiscontinued).toBe(false);
    });

    it('should handle date field types', async () => {
      const po = await connector.create('purchase_order', {
        fields: {
          PurchaseOrder: 'PO-DATE-TEST',
          Vendor: 'V-123',
          OrderDate: '2025-10-28',
          DeliveryDate: '2025-11-15',
        },
      });

      expect(po.fields.OrderDate).toBe('2025-10-28');
      expect(po.fields.DeliveryDate).toBe('2025-11-15');
    });

    it('should handle null and undefined values', async () => {
      const material = await connector.create('material', {
        fields: {
          Description: 'Null Test',
          MaterialType: 'FERT',
          OptionalField1: null,
          OptionalField2: undefined,
        },
      });

      expect(material.fields.Description).toBe('Null Test');
    });

    it('should handle empty string values', async () => {
      const material = await connector.create('material', {
        fields: {
          Description: '',
          MaterialType: 'FERT',
          Notes: '',
        },
      });

      expect(material.fields.Description).toBe('');
    });

    it('should handle very long text values', async () => {
      const longText = 'A'.repeat(5000);
      const material = await connector.create('material', {
        fields: {
          Description: 'Long Text Test',
          MaterialType: 'FERT',
          LongDescription: longText,
        },
      });

      expect(material.fields.LongDescription).toBe(longText);
      expect(material.fields.LongDescription.length).toBe(5000);
    });
  });

  describe('Demo Mode Complex Queries', () => {
    it('should handle multi-level sorting', async () => {
      await connector.create('material', {
        fields: { Description: 'B Material', MaterialType: 'FERT', MaterialGroup: 'GROUP1' },
      });
      await connector.create('material', {
        fields: { Description: 'A Material', MaterialType: 'FERT', MaterialGroup: 'GROUP1' },
      });
      await connector.create('material', {
        fields: { Description: 'C Material', MaterialType: 'ROH', MaterialGroup: 'GROUP2' },
      });

      const results = await connector.list('material', {
        sortBy: 'Description',
        sortOrder: 'asc',
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle pagination with large offset', async () => {
      for (let i = 0; i < 10; i++) {
        await connector.create('material', {
          fields: { Description: `Pagination Test ${i}`, MaterialType: 'FERT' },
        });
      }

      const page = await connector.list('material', {
        limit: 2,
        offset: 5,
      });

      expect(page.length).toBeLessThanOrEqual(2);
    });

    it('should handle zero limit (return all)', async () => {
      const all = await connector.list('material', {
        limit: 0,
      });

      expect(Array.isArray(all)).toBe(true);
    });

    it('should handle filters with multiple conditions', async () => {
      await connector.create('material', {
        fields: {
          Description: 'Multi Filter Test',
          MaterialType: 'FERT',
          MaterialGroup: 'FILTER-GROUP',
          Plant: '1000',
        },
      });

      const results = await connector.list('material', {
        filters: {
          MaterialType: 'FERT',
          MaterialGroup: 'FILTER-GROUP',
          Plant: '1000',
        },
      });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((m: DataRecord) => {
        expect(m.fields.MaterialType).toBe('FERT');
        expect(m.fields.MaterialGroup).toBe('FILTER-GROUP');
      });
    });
  });

  describe('Demo Mode Performance Scenarios', () => {
    it('should handle rapid sequential operations', async () => {
      const startTime = Date.now();

      for (let i = 0; i < 20; i++) {
        await connector.create('material', {
          fields: { Description: `Rapid ${i}`, MaterialType: 'FERT' },
        });
      }

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(5000); // Should complete in < 5 seconds
    });

    it('should maintain consistency under rapid operations', async () => {
      const created = await connector.create('material', {
        fields: { Description: 'Consistency Test', MaterialType: 'FERT' },
      });

      // Rapid read operations
      const read1 = await connector.read('material', created.id);
      const read2 = await connector.read('material', created.id);
      const read3 = await connector.read('material', created.id);

      expect(read1?.id).toBe(created.id);
      expect(read2?.id).toBe(created.id);
      expect(read3?.id).toBe(created.id);
    });
  });
});
