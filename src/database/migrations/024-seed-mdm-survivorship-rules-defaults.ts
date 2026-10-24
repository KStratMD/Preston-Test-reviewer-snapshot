import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'seed_mdm_survivorship_rules_defaults',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        INSERT OR IGNORE INTO mdm_survivorship_rules (id, entity_type, field_name, strategy, config, priority, is_default) VALUES
          ('v-name',        'vendor',   'name',        'most_complete',   '{}',                                           1, 1),
          ('v-email',       'vendor',   'email',       'most_recent',     '{}',                                           2, 1),
          ('v-phone',       'vendor',   'phone',       'most_recent',     '{}',                                           2, 1),
          ('v-address',     'vendor',   'address',     'most_complete',   '{}',                                           3, 1),
          ('v-taxId',       'vendor',   'taxId',       'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
          ('c-name',        'customer', 'name',        'most_complete',   '{}',                                           1, 1),
          ('c-email',       'customer', 'email',       'most_recent',     '{}',                                           2, 1),
          ('c-phone',       'customer', 'phone',       'most_recent',     '{}',                                           2, 1),
          ('c-creditLimit', 'customer', 'creditLimit', 'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
          ('p-name',        'product',  'name',        'most_complete',   '{}',                                           1, 1),
          ('p-sku',         'product',  'sku',         'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
          ('p-price',       'product',  'price',       'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
          ('p-description', 'product',  'description', 'most_complete',   '{}',                                           2, 1),
          ('default',       '*',        '*',           'most_recent',     '{}',                                         999, 1)
      `.execute(db);
    } else {
      await sql`
        INSERT INTO mdm_survivorship_rules (id, entity_type, field_name, strategy, config, priority, is_default) VALUES
          ('v-name',        'vendor',   'name',        'most_complete',   '{}',                                           1, 1),
          ('v-email',       'vendor',   'email',       'most_recent',     '{}',                                           2, 1),
          ('v-phone',       'vendor',   'phone',       'most_recent',     '{}',                                           2, 1),
          ('v-address',     'vendor',   'address',     'most_complete',   '{}',                                           3, 1),
          ('v-taxId',       'vendor',   'taxId',       'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
          ('c-name',        'customer', 'name',        'most_complete',   '{}',                                           1, 1),
          ('c-email',       'customer', 'email',       'most_recent',     '{}',                                           2, 1),
          ('c-phone',       'customer', 'phone',       'most_recent',     '{}',                                           2, 1),
          ('c-creditLimit', 'customer', 'creditLimit', 'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
          ('p-name',        'product',  'name',        'most_complete',   '{}',                                           1, 1),
          ('p-sku',         'product',  'sku',         'source_priority', '{"sourcePriority":["netsuite","bc"]}',         1, 1),
          ('p-price',       'product',  'price',       'source_priority', '{"sourcePriority":["netsuite"]}',              1, 1),
          ('p-description', 'product',  'description', 'most_complete',   '{}',                                           2, 1),
          ('default',       '*',        '*',           'most_recent',     '{}',                                         999, 1)
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }
  },
};
