/* eslint-env node */
/* eslint-disable no-undef */

/**
 * Jest Fast Configuration
 * Quick unit tests without coverage - for development.
 * Extends: jest.base.config.cjs
 * @type {import('jest').Config}
 */
const baseConfig = require('./jest.base.config.cjs');

module.exports = {
  ...baseConfig,
  // Fast runs: disable coverage collection for speed
  collectCoverage: false
};
