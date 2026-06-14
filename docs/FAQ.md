# Frequently Asked Questions (FAQ)

**Last Updated**: April 21, 2026
**Version**: 3.3.0
**Test Status**: 12,214 tests passing (100% pass rate, 16 skipped)

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [AI Configuration](#ai-configuration)
3. [Connectors](#connectors)
4. [Demo vs Production Mode](#demo-vs-production-mode)
5. [Common Errors](#common-errors)
6. [Testing](#testing)
7. [Security](#security)
8. [Performance](#performance)
9. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Q: How do I start the application?

**A:** Run these commands:

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Or start in production mode
npm start
```

The application will be available at `http://localhost:3000`.

---

### Q: What are the minimum system requirements?

**A:**
- Node.js 20+ (LTS recommended)
- npm 10+
- 4GB RAM minimum (8GB recommended for AI features)
- PostgreSQL 14+ (optional, SQLite used by default)
- Redis 6+ (optional, for caching)

---

### Q: How do I run the tests?

**A:**

```bash
# Run all unit tests
npm test

# Run with coverage
npm run test:coverage

# Run integration tests
npm run test:integration

# Run specific test file
npm test -- --testPathPatterns="NetSuite"
```

Current test status: **12,214 tests passing** (100% pass rate, 16 skipped).

### Q: Which AI providers are supported?

**A:** The platform supports 4 real AI providers, 2 experimental providers, and a rule-based fallback:

| Provider | Model | Cost per Mapping | Best For |
|----------|-------|------------------|----------|
| **OpenAI** | GPT-4o | ~$0.02 | High accuracy, production use |
| **Claude** | Claude 3.5 Sonnet | ~$0.003 | Cost-effective, excellent quality |
| **OpenRouter** | 50+ models | Varies (free tier available) | Multi-model access via single API key |
| **Gemini** | Gemini Pro | ~$0.001 | Budget-friendly |
| **Grok** | Grok-1 | ~$0.005 | Fast responses |
| **LMStudio** | Local models | Free | Privacy, offline use |
| **Mock** | Demo data | Free | Testing, demos |

---

### Q: How do I configure an AI provider?

**A:** Set environment variables in your `.env` file:

```bash
# OpenAI
OPENAI_API_KEY=sk-your-key-here

# Claude (Anthropic)
ANTHROPIC_API_KEY=sk-ant-your-key-here
ANTHROPIC_AUTH_MODE=auto              # auto|anthropic|bearer (for proxies/gateways)

# OpenRouter (multi-model gateway)
OPENROUTER_API_KEY=sk-or-your-key-here
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet  # or openrouter/free, openai/gpt-4o, etc.

# LMStudio (local)
LMSTUDIO_BASE_URL=http://localhost:1234

# Gemini
GOOGLE_AI_API_KEY=your-key-here

# Grok
GROK_API_KEY=your-key-here
```

Then restart the server. The provider will be automatically registered.

---

### Q: What AI accuracy can I expect?

**A:** Field mapping accuracy varies by provider:

- **Production providers** (OpenAI, Claude): measurably improved accuracy (benchmark pending)
- **Local providers** (LMStudio): 85-95% accuracy depending on model
- **Demo mode**: Returns realistic sample suggestions

The AI system uses multiple strategies:
1. Semantic similarity analysis
2. Data type matching
3. Business context understanding
4. Historical mapping patterns

---

### Q: How do I use AI without an API key?

**A:** The platform works in **demo mode** without any API keys:

- AI field mapping returns realistic suggestions
- All features are functional with sample data
- Perfect for evaluation and testing

To enable demo mode, simply don't configure any AI provider keys.

---

## Connectors

### Q: Which systems can I integrate?

**A:** Currently supported connectors:

**Production-Ready (5) + Beta (1):**
- NetSuite (OAuth 1.0, REST API)
- Salesforce (OAuth 2.0, REST + SOAP)
- Business Central (OAuth 2.0, OData v4)
- Oracle (Basic auth, REST)
- HubSpot CRM (API key, OAuth 2.0)
- ShipStation 3PL (API key)

**Fixture-Based (10):**
- SAP, Dynamics 365, Shopify, WooCommerce
- Stripe, Square, PayPal, Adyen
- QuickBooks, Xero

All connectors support demo mode without credentials.

---

### Q: How do I connect to NetSuite?

**A:** See the detailed guide: [NetSuite Setup Guide](tutorials/NETSUITE-SETUP-GUIDE.md)

Quick setup:
```bash
# .env configuration
NETSUITE_ACCOUNT_ID=your-account-id
NETSUITE_CONSUMER_KEY=your-consumer-key
NETSUITE_CONSUMER_SECRET=your-consumer-secret
NETSUITE_TOKEN_ID=your-token-id
NETSUITE_TOKEN_SECRET=your-token-secret
```

Test connection:
```bash
npx ts-node scripts/test-netsuite-connection.ts
```

---

### Q: Why is my connector returning demo data?

**A:** Connectors automatically fall back to demo mode when:

1. **No credentials configured** - Set the required environment variables
2. **Invalid credentials** - Check API keys and tokens
3. **Connection failed** - Check network and firewall settings
4. **Rate limited** - Wait and retry, or check API quotas

Check connector status at `/api/connectors/status` or the System Status dashboard.

---

## Demo vs Production Mode

### Q: What's the difference between demo and production mode?

**A:**

| Feature | Demo Mode | Production Mode |
|---------|-----------|-----------------|
| **Data** | Sample/fixture data | Live system data |
| **API Calls** | None (simulated) | Real API calls |
| **Credentials** | Not required | Required |
| **Cost** | Free | API usage costs |
| **Use Case** | Testing, evaluation | Live integrations |

---

### Q: How do I know if I'm in demo mode?

**A:** Check these indicators:

1. **API Response**: Demo responses include `"mode": "demo"` in metadata
2. **System Status**: Dashboard shows connector mode status
3. **Logs**: Demo operations logged as `[DEMO]`
4. **Data IDs**: Demo data uses predictable IDs like `demo-001`

---

### Q: How do I switch from demo to production?

**A:**

1. Configure credentials in `.env`:
   ```bash
   OPENAI_API_KEY=sk-your-real-key
   NETSUITE_ACCOUNT_ID=your-real-account
   # ... etc
   ```

2. Restart the server:
   ```bash
   npm run build && npm start
   ```

3. Verify connection:
   ```bash
   # Check system status
   curl http://localhost:3000/api/health
   ```

---

## Common Errors

### Q: "Cannot GET /my-page.html" - Page not found

**A:** New HTML files must be whitelisted. Add the filename to `src/middleware/setup/RouteSetup.ts`:

```typescript
// Find the htmlFiles array (~line 407)
const htmlFiles = [
  'index.html',
  'my-page.html',  // Add your file here
  // ...
];
```

Then rebuild: `npm run build && npm start`

---

### Q: "No matching bindings found for serviceIdentifier"

**A:** This is a dependency injection error. The service isn't registered in the IoC container.

**Fix**: Add binding in `src/inversify/inversify.config.ts`:
```typescript
container.bind<YourService>(TYPES.YourService)
  .to(YourService)
  .inSingletonScope();
```

---

### Q: "EADDRINUSE: address already in use"

**A:** Port 3000 is already in use. Either:

1. Kill the existing process:
   ```bash
   # Windows
   taskkill /F /IM node.exe

   # Linux/Mac
   pkill -f "node.*index"
   ```

2. Or use a different port:
   ```bash
   PORT=3001 npm start
   ```

---

### Q: "OAuth signature mismatch" (NetSuite)

**A:** OAuth 1.0 signature issues are usually caused by:

1. **Clock drift** - Ensure server time is accurate (within 5 minutes of NetSuite)
2. **Encoding issues** - Special characters in credentials
3. **Wrong credentials** - Verify all 5 OAuth values are correct
4. **Role permissions** - Token must have appropriate role

Debug with: `npx ts-node scripts/test-netsuite-connection.ts`

---

### Q: "Rate limit exceeded"

**A:** You've hit API rate limits. Solutions:

1. **Wait and retry** - Most limits reset within minutes
2. **Enable caching** - Reduce redundant API calls
3. **Use batch operations** - Combine multiple requests
4. **Check governance** - NetSuite has specific governance limits

See: [Security and Rate Limiting Guide](guides/SECURITY-AND-RATE-LIMITING.md)

---

## Testing

### Q: How do I run specific tests?

**A:**

```bash
# By file pattern
npm test -- --testPathPatterns="NetSuite"

# By test name
npm test -- -t "should connect"

# Single file
npm test -- tests/unit/__tests__/NetSuiteConnector.test.ts

# With coverage
npm run test:coverage
```

---

### Q: Why are some tests skipped?

**A:** Across all profiles, 6 tests are intentionally skipped (unit profile: 0 skipped; integration: 6):

- **8 tests**: Require external API credentials (OpenAI, etc.)
- **7 tests**: Features not yet implemented (planned)
- **3 tests**: Complex OAuth flows requiring manual setup
- **2 tests**: Performance tests (run separately)

Run skipped tests with credentials:
```bash
OPENAI_API_KEY=sk-xxx npm test -- --testPathPatterns="openai"
```

---

### Q: How do I add new tests?

**A:** Follow these patterns:

1. **Unit tests**: `tests/unit/[category]/[Name].test.ts`
2. **Integration tests**: `tests/integration/[name].integration.test.ts`
3. **Contract tests**: `tests/unit/contract/[Connector].contract.test.ts`

Example:
```typescript
describe('MyService', () => {
  let service: MyService;

  beforeEach(() => {
    service = new MyService(mockLogger);
  });

  it('should do something', async () => {
    const result = await service.doSomething();
    expect(result).toBeDefined();
  });
});
```

---

## Security

### Q: How are credentials stored?

**A:** Credentials are managed securely:

1. **Environment variables** - `.env` file (not committed to git)
2. **AWS Secrets Manager** - Production deployments
3. **Database encryption** - Sensitive fields encrypted at rest
4. **No hardcoding** - Credentials never in source code

See: [Security Guide](guides/SECURITY-AND-RATE-LIMITING.md)

---

### Q: What security features are implemented?

**A:**

| Feature | Status | Description |
|---------|--------|-------------|
| JWT Authentication | Active | Token-based API auth |
| Rate Limiting | Active | DoS protection |
| Input Sanitization | Active | XSS/injection prevention |
| CORS | Active | Cross-origin protection |
| Webhook Validation | Active | HMAC signature verification |
| Tenant Isolation | Active | Multi-tenant data separation |
| Audit Logging | Active | All operations logged |

---

### Q: Is the platform SOC2 compliant?

**A:** The platform implements SOC2-ready controls:

- Comprehensive audit logging
- Role-based access control
- Encryption at rest and in transit
- Secrets management
- Change tracking

Full compliance requires organizational policies and third-party audit.

---

## Performance

### Q: What are typical response times?

**A:**

| Operation | Typical Time | Max Time |
|-----------|--------------|----------|
| Health check | <50ms | 100ms |
| Simple CRUD | <100ms | 500ms |
| AI field mapping | 2-5s | 30s |
| Batch sync (100 records) | 5-15s | 60s |
| Report generation | 1-3s | 30s |

---

### Q: How do I improve performance?

**A:**

1. **Enable caching** - Redis for frequently accessed data
2. **Use batch operations** - Reduce API call count
3. **Connection pooling** - Database connection reuse
4. **Async processing** - Queue long-running tasks
5. **Index optimization** - Database query optimization

---

### Q: How many concurrent users are supported?

**A:** Tested configurations:

- **Development**: 10-20 concurrent users
- **Staging**: 50+ concurrent users
- **Production (K8s)**: 100+ concurrent users with auto-scaling

Scaling is configured via Helm values for Kubernetes deployments.

---

## Troubleshooting

### Q: Where are the logs?

**A:**

- **Console**: Real-time logs during development
- **File**: `logs/` directory (if configured)
- **Docker**: `docker logs <container-id>`
- **Production**: CloudWatch or your logging provider

Log levels: `error`, `warn`, `info`, `debug`, `trace`

---

### Q: How do I enable debug logging?

**A:** Set the log level in `.env`:

```bash
LOG_LEVEL=debug
```

Or for specific components:
```bash
DEBUG=app:connectors:*
```

---

### Q: How do I report a bug?

**A:**

1. **GitHub Issues**: https://github.com/KStratMD/Preston-Test/issues
2. Include:
   - Steps to reproduce
   - Expected vs actual behavior
   - Error messages and logs
   - Environment (OS, Node version, etc.)

---

### Q: Where can I get help?

**A:**

- **Documentation**: `docs/` directory
- **Tutorials**: `docs/tutorials/` (38 guides)
- **API Reference**: `docs/api/API.md`
- **Help Chat**: Built-in help widget on dashboards
- **GitHub Issues**: Bug reports and feature requests

---

## Quick Reference

### Essential Commands

```bash
# Development
npm run dev          # Start dev server
npm test             # Run tests
npm run lint         # Check code style
npm run build        # Build for production

# Production
npm start            # Start production server
npm run typecheck    # TypeScript validation

# Utilities
npm run quality:check    # Full quality validation
npm run test:coverage    # Tests with coverage
npm run test:integration # Integration tests
```

### Key Files

| File | Purpose |
|------|---------|
| `.env` | Environment configuration |
| `CLAUDE.md` | Developer notes and fixes |
| `docs/README.md` | Documentation index |
| `src/middleware/setup/RouteSetup.ts` | Route configuration |
| `src/inversify/inversify.config.ts` | Dependency injection |

### Dashboards

| Dashboard | URL | Purpose |
|-----------|-----|---------|
| Main Hub | `/index.html` | Navigation and overview |
| AI Mapping Studio | `/ai-mapping-studio.html` | Field mapping |
| System Status | `/system-status.html` | Health monitoring |
| Executive Hub | `/executive/executive-hub.html` | Business metrics |

---

**Need more help?** Check the [full documentation](README.md) or open an issue on GitHub.
