#!/usr/bin/env node

const [, , scriptName = 'unknown', phase = 'a later phase'] = process.argv;

console.error(`[plan-stub] '${scriptName}' is not yet implemented (lands in ${phase}). See the project plans documentation for details.`);
process.exit(1);
