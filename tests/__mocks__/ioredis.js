// Mock for IORedis
class MockIORedis {
  constructor(options = {}) {
    this.options = options;
    this.status = 'ready';
  }

  on(event, callback) {
    return this;
  }

  async disconnect() {
    return 'OK';
  }

  async quit() {
    return 'OK';
  }
}

// Handle both ES module and CommonJS exports
MockIORedis.default = MockIORedis;

module.exports = MockIORedis;
module.exports.default = MockIORedis;
