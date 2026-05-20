import { FieldMapperUtility, type FieldMappingMetadata } from '../fieldMapper';
import { Logger } from '../Logger';

describe('FieldMapperUtility', () => {
  const logger = new Logger('FieldMapperTest');
  const mapper = new FieldMapperUtility(logger);

  test('calculations use safe expr-eval and support {field} placeholders', async () => {
    const source = { a: 10, b: 5 } as any;
    const metadata: FieldMappingMetadata = {
      sourceSystem: 'src',
      targetSystem: 'tgt',
      module: 'Test',
      recordType: 'calc',
      mappings: [
        {
          sourceField: 'a',
          targetField: 'sum',
          transformation: 'calculation',
          transformationValue: '{a} + {b} * 2',
          required: true,
        },
      ],
    };

    const res = await mapper.mapFields(source, metadata);
    expect(res.success).toBe(true);
    expect(res.mappedRecord?.sum).toBe(20); // 10 + 5*2
  });

  test('lookup transformation maps using provided table', async () => {
    const source = { status: 'active' } as any;
    const metadata: FieldMappingMetadata = {
      sourceSystem: 'src',
      targetSystem: 'tgt',
      module: 'Test',
      recordType: 'lookup',
      mappings: [
        {
          sourceField: 'status',
          targetField: 'isActive',
          transformation: 'lookup',
          transformationValue: '{"active": true, "inactive": false, "_default": false}',
          required: true,
        },
      ],
    };

    const res = await mapper.mapFields(source, metadata);
    expect(res.success).toBe(true);
    expect(res.mappedRecord?.isActive).toBe(true);
  });

  test('concatenation transformation substitutes placeholders', async () => {
    const source = { name: 'Acme', id: 123 } as any;
    const metadata: FieldMappingMetadata = {
      sourceSystem: 'src',
      targetSystem: 'tgt',
      module: 'Test',
      recordType: 'concat',
      mappings: [
        {
          sourceField: 'name',
          targetField: 'label',
          transformation: 'concatenation',
          transformationValue: 'Name: {name} ({id})',
          required: true,
        },
      ],
    };

    const res = await mapper.mapFields(source, metadata);
    expect(res.success).toBe(true);
    expect(res.mappedRecord?.label).toBe('Name: Acme (123)');
  });

  test('conditional transformation works for equality', async () => {
    const source = { status: 'active' } as any;
    const metadata: FieldMappingMetadata = {
      sourceSystem: 'src',
      targetSystem: 'tgt',
      module: 'Test',
      recordType: 'cond',
      mappings: [
        {
          sourceField: 'status',
          targetField: 'stateCode',
          transformation: 'conditional',
          transformationValue: "if {status} == 'active' then 'A' else 'I'",
          required: true,
        },
      ],
    };

    const res = await mapper.mapFields(source, metadata);
    expect(res.success).toBe(true);
    expect(res.mappedRecord?.stateCode).toBe('A');
  });
});

