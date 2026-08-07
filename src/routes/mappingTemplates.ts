import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import fs from 'fs';
import path from 'path';

interface FieldTemplate {
  source: string;
  target: string;
  transformation: string;
  params?: Record<string, unknown>;
}

export interface MappingTemplate {
  key: string;
  name: string;
  description?: string;
  sourceSystem?: string;
  targetSystem?: string;
  fields: FieldTemplate[];
  source?: 'builtin' | 'custom';
  tags?: string[];
}

function getStorePath(): string {
  const dir = path.resolve(process.cwd(), 'config');
  try { 
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); 
  } catch {
    // Ignore directory creation errors
  }
  return path.join(dir, 'mapping-templates.json');
}

function readCustomTemplates(): MappingTemplate[] {
  const p = getStorePath();
  try {
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return (data as MappingTemplate[]).map(t => ({ ...t, source: 'custom' }));
    return [];
  } catch {
    return [];
  }
}

function writeCustomTemplates(templates: MappingTemplate[]) {
  const p = getStorePath();
  fs.writeFileSync(p, JSON.stringify(templates, null, 2), 'utf8');
}

function builtinTemplates(): MappingTemplate[] {
  return [
    {
      key: 'suitecentral-customer',
      name: 'SuiteCentral: Customer Standard',
      description: 'Basic customer identity/contact mapping',
      sourceSystem: 'Salesforce',
      targetSystem: 'SuiteCentral',
      fields: [
        { source: 'firstName', target: 'first_name', transformation: 'direct' },
        { source: 'lastName', target: 'last_name', transformation: 'direct' },
        { source: 'email', target: 'email', transformation: 'lowercase' },
        { source: 'phone', target: 'phone', transformation: 'format', params: { format: '{value}' } },
        { source: 'companyName', target: 'company', transformation: 'direct' },
        { source: 'firstName', target: 'full_name', transformation: 'concatenation', params: { template: '{firstName} {lastName}' } },
      ],
      source: 'builtin',
      tags: ['suitecentral','customer','standard'],
    },
    {
      key: 'suitecentral-po-lines',
      name: 'SuiteCentral: Purchase Order Lines',
      description: 'Line item mapping for purchase orders',
      sourceSystem: 'NetSuite',
      targetSystem: 'SuiteCentral',
      fields: [
        { source: 'itemName', target: 'item', transformation: 'direct' },
        { source: 'quantity', target: 'qty', transformation: 'direct' },
        { source: 'unitPrice', target: 'unit_price', transformation: 'calculation', params: { expr: 'Number(row.unitPrice)' } },
        { source: 'currency', target: 'currency', transformation: 'lookup', params: { map: '{"USD":"US$","EUR":"€"}' } },
        { source: 'note', target: 'line_note', transformation: 'replace', params: { pattern: '\n', with: ' ' } },
      ],
      source: 'builtin',
      tags: ['suitecentral','purchase-order','lines'],
    },
    {
      key: 'suitecentral-vendor-basic',
      name: 'SuiteCentral: Vendor Basic',
      description: 'Basic vendor master data mapping',
      sourceSystem: 'SAP ERP',
      targetSystem: 'SuiteCentral',
      fields: [
        { source: 'vendorName', target: 'name', transformation: 'direct' },
        { source: 'category', target: 'category', transformation: 'direct' },
        { source: 'email', target: 'email', transformation: 'lowercase' },
        { source: 'phone', target: 'phone', transformation: 'format', params: { format: '{value}' } },
        { source: 'creditRating', target: 'rating', transformation: 'lookup', params: { map: '{"A+":"Excellent","A":"Strong","B":"Fair"}' } },
      ],
      source: 'builtin',
      tags: ['suitecentral','vendor','master-data'],
    },
    {
      key: 'salesforce-netsuite-customers',
      name: 'Salesforce to NetSuite Customer Sync',
      description: 'Standard customer data mapping between Salesforce and NetSuite with address normalization',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      fields: [
        { source: 'Name', target: 'companyname', transformation: 'direct' },
        { source: 'AccountNumber', target: 'entityid', transformation: 'direct' },
        { source: 'Phone', target: 'phone', transformation: 'format', params: { format: '{value}' } },
        { source: 'Website', target: 'url', transformation: 'direct' },
        { source: 'BillingStreet', target: 'billaddr1', transformation: 'direct' },
        { source: 'BillingCity', target: 'billcity', transformation: 'direct' },
        { source: 'BillingState', target: 'billstate', transformation: 'lookup', params: { map: '{"CA":"California","NY":"New York","TX":"Texas"}' } },
        { source: 'BillingPostalCode', target: 'billzip', transformation: 'format', params: { format: '{value}' } },
        { source: 'Type', target: 'category', transformation: 'lookup', params: { map: '{"Customer":"Customer","Partner":"Partner","Prospect":"Lead"}' } },
      ],
      source: 'builtin',
      tags: ['salesforce','netsuite','customer','crm-erp'],
    },
    {
      key: 'netsuite-dynamics-products',
      name: 'NetSuite to Dynamics 365 Product Sync',
      description: 'Product catalog synchronization with inventory and pricing',
      sourceSystem: 'NetSuite',
      targetSystem: 'Dynamics 365',
      fields: [
        { source: 'itemid', target: 'productnumber', transformation: 'direct' },
        { source: 'displayname', target: 'name', transformation: 'direct' },
        { source: 'description', target: 'description', transformation: 'direct' },
        { source: 'baseprice', target: 'price', transformation: 'calculation', params: { expr: 'Number(row.baseprice)' } },
        { source: 'quantityavailable', target: 'quantityonhand', transformation: 'direct' },
        { source: 'weight', target: 'size', transformation: 'concatenation', params: { template: '{weight} lbs' } },
        { source: 'department', target: 'productstructure', transformation: 'lookup', params: { map: '{"Sales":"Product","Service":"Service","Inventory":"Product"}' } },
      ],
      source: 'builtin',
      tags: ['netsuite','dynamics','product','inventory'],
    },
    {
      key: 'sap-oracle-financials',
      name: 'SAP ERP to Oracle Financials',
      description: 'Financial transaction mapping with currency conversion and GL accounts',
      sourceSystem: 'SAP ERP',
      targetSystem: 'Oracle',
      fields: [
        { source: 'BELNR', target: 'voucher_num', transformation: 'direct' },
        { source: 'GJAHR', target: 'period_year', transformation: 'direct' },
        { source: 'BUDAT', target: 'gl_date', transformation: 'format', params: { format: 'YYYY-MM-DD' } },
        { source: 'WRBTR', target: 'entered_dr', transformation: 'calculation', params: { expr: 'Number(row.WRBTR)' } },
        { source: 'WAERS', target: 'currency_code', transformation: 'direct' },
        { source: 'HKONT', target: 'code_combination_id', transformation: 'lookup', params: { map: '{"1000":"10001","2000":"20001","3000":"30001"}' } },
        { source: 'SGTXT', target: 'description', transformation: 'direct' },
      ],
      source: 'builtin',
      tags: ['sap','oracle','financial','gl-posting'],
    },
    {
      key: 'dynamics-salesforce-opportunities',
      name: 'Dynamics 365 to Salesforce Opportunities',
      description: 'Sales opportunity pipeline synchronization with stage mapping',
      sourceSystem: 'Dynamics 365',
      targetSystem: 'Salesforce',
      fields: [
        { source: 'name', target: 'Name', transformation: 'direct' },
        { source: 'estimatedvalue', target: 'Amount', transformation: 'calculation', params: { expr: 'Number(row.estimatedvalue)' } },
        { source: 'estimatedclosedate', target: 'CloseDate', transformation: 'format', params: { format: 'YYYY-MM-DD' } },
        { source: 'salesstage', target: 'StageName', transformation: 'lookup', params: { map: '{"1":"Prospecting","2":"Qualification","3":"Needs Analysis","4":"Value Proposition","5":"Proposal","6":"Negotiation","7":"Closed Won"}' } },
        { source: 'description', target: 'Description', transformation: 'direct' },
        { source: 'customerid', target: 'AccountId', transformation: 'direct' },
      ],
      source: 'builtin',
      tags: ['dynamics','salesforce','opportunity','sales-pipeline'],
    },
    {
      key: 'business-central-netsuite-items',
      name: 'Business Central to NetSuite Items',
      description: 'Item master synchronization with SKU validation and categorization',
      sourceSystem: 'Business Central',
      targetSystem: 'NetSuite',
      fields: [
        { source: 'No', target: 'itemid', transformation: 'direct' },
        { source: 'Description', target: 'displayname', transformation: 'direct' },
        { source: 'BaseUnitofMeasure', target: 'unitstype', transformation: 'lookup', params: { map: '{"PCS":"Each","BOX":"Box","KG":"Pound"}' } },
        { source: 'UnitPrice', target: 'baseprice', transformation: 'calculation', params: { expr: 'Number(row.UnitPrice)' } },
        { source: 'Inventory', target: 'quantityavailable', transformation: 'direct' },
        { source: 'ItemCategoryCode', target: 'class', transformation: 'direct' },
        { source: 'Blocked', target: 'isinactive', transformation: 'lookup', params: { map: '{"Yes":"T","No":"F"}' } },
      ],
      source: 'builtin',
      tags: ['business-central','netsuite','item','inventory'],
    },
    {
      key: 'generic-contact-mapping',
      name: 'Generic Contact Mapping',
      description: 'Universal contact/person mapping template for any system',
      sourceSystem: 'Any',
      targetSystem: 'Any',
      fields: [
        { source: 'first_name', target: 'firstName', transformation: 'direct' },
        { source: 'last_name', target: 'lastName', transformation: 'direct' },
        { source: 'email', target: 'emailAddress', transformation: 'lowercase' },
        { source: 'phone', target: 'phoneNumber', transformation: 'format', params: { format: '{value}' } },
        { source: 'company', target: 'companyName', transformation: 'direct' },
        { source: 'title', target: 'jobTitle', transformation: 'direct' },
        { source: 'first_name', target: 'fullName', transformation: 'concatenation', params: { template: '{first_name} {last_name}' } },
      ],
      source: 'builtin',
      tags: ['generic','contact','person','universal'],
    },
    {
      key: 'generic-address-mapping',
      name: 'Generic Address Mapping',
      description: 'Universal address mapping template with international support',
      sourceSystem: 'Any',
      targetSystem: 'Any',
      fields: [
        { source: 'street_address', target: 'addressLine1', transformation: 'direct' },
        { source: 'address_line_2', target: 'addressLine2', transformation: 'direct' },
        { source: 'city', target: 'city', transformation: 'direct' },
        { source: 'state', target: 'stateProvince', transformation: 'direct' },
        { source: 'postal_code', target: 'postalCode', transformation: 'format', params: { format: '{value}' } },
        { source: 'country', target: 'country', transformation: 'lookup', params: { map: '{"US":"United States","CA":"Canada","UK":"United Kingdom"}' } },
        { source: 'street_address', target: 'fullAddress', transformation: 'concatenation', params: { template: '{street_address}, {city}, {state} {postal_code}' } },
      ],
      source: 'builtin',
      tags: ['generic','address','location','universal'],
    },
  ];
}

export function createMappingTemplatesRouter(): Router {
  const router = Router();

  router.get('/', asyncHandler(async (_req, res) => {
    const all = [...builtinTemplates(), ...readCustomTemplates()];
    res.json({ templates: all });
  }));

  router.get('/:key', asyncHandler(async (req, res) => {
    const k = String(req.params.key);
    const all = [...builtinTemplates(), ...readCustomTemplates()];
    const t = all.find(x => x.key === k);
    if (!t) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json(t);
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const body = (req.body || {}) as Partial<MappingTemplate>;
    if (!body || !body.name || !Array.isArray(body.fields)) return res.status(400).json({ error: 'INVALID_TEMPLATE' });
    const key = (body.key && typeof body.key === 'string') ? body.key : body.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const custom = readCustomTemplates();
    const idx = custom.findIndex(t => t.key === key);
    const toSave: MappingTemplate = {
      key,
      name: body.name!,
      description: body.description || '',
      sourceSystem: body.sourceSystem,
      targetSystem: body.targetSystem,
      fields: body.fields as FieldTemplate[],
      source: 'custom',
      tags: Array.isArray((body as any).tags) ? (body as any).tags.filter((x: unknown)=> typeof x === 'string' && x.trim()).map((s: string)=>s.trim()) : undefined,
    };
    if (idx >= 0) custom[idx] = toSave; else custom.unshift(toSave);
    writeCustomTemplates(custom);
    return res.status(201).json(toSave);
  }));

  // Delete a custom template (builtin templates cannot be deleted)
  router.delete('/:key', asyncHandler(async (req, res) => {
    const key = String(req.params.key);
    const customs = readCustomTemplates();
    const idx = customs.findIndex(t => t.key === key);
    if (idx === -1) return res.status(404).json({ error: 'NOT_FOUND_OR_BUILTIN' });
    customs.splice(idx, 1);
    writeCustomTemplates(customs);
    return res.json({ success: true });
  }));

  // Export all templates (builtin + custom)
  router.get('/export/all', asyncHandler(async (_req, res) => {
    const all = [...builtinTemplates(), ...readCustomTemplates()];
    res.type('application/json').send(JSON.stringify({ templates: all }, null, 2));
  }));

  // Import templates (array or { templates: [...] }) and merge into custom store
  router.post('/import', asyncHandler(async (req, res) => {
    const payload = Array.isArray(req.body) ? req.body : (req.body && Array.isArray(req.body.templates) ? req.body.templates : []);
    if (!Array.isArray(payload)) return res.status(400).json({ error: 'INVALID_PAYLOAD' });
    const customs = readCustomTemplates();
    const map = new Map<string, MappingTemplate>(customs.map(t => [t.key, t]));
    let imported = 0;
    for (const raw of payload) {
      if (!raw || typeof raw !== 'object') continue;
      const key = String((raw as any).key || (raw as any).name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const name = (raw as any).name || key;
      const fields = (raw as any).fields;
      if (!key || !name || !Array.isArray(fields)) continue;
      const tpl: MappingTemplate = {
        key,
        name,
        description: (raw as any).description || '',
        sourceSystem: (raw as any).sourceSystem,
        targetSystem: (raw as any).targetSystem,
        fields: fields as FieldTemplate[],
        source: 'custom',
      };
      map.set(key, tpl);
      imported++;
    }
    writeCustomTemplates(Array.from(map.values()));
    return res.json({ success: true, imported });
  }));

  return router;
}
