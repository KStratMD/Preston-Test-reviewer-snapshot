# 002. AI Provider Registry and Dynamic Dispatch

**Status**: Accepted

**Context**:
The system needs to support multiple AI providers (OpenAI, Claude, etc.) to enable cost optimization, performance comparison, and fallback capabilities. The current implementation lacks a centralized, scalable way to manage these providers. The Master Implementation Plan (Week 2) calls for a multi-provider infrastructure.

**Decision**:
1.  A `ProviderRegistry` service will be implemented on the server-side.
2.  This registry will be responsible for loading all available AI provider configurations at startup from secure environment variables.
3.  Each provider will have a standardized interface (`AIProvider`) with methods like `generateMappingSuggestions`, `analyzeDataQuality`, etc.
4.  The AI proxy endpoint will use the `ProviderRegistry` to dynamically dispatch requests to the selected provider based on a parameter in the client's request (e.g., `provider: 'openai'`).
5.  The registry will also handle fallback logic: if a primary provider fails, it can automatically retry the request with a secondary provider.

**Consequences**:
*   **Positive**:
    *   Creates a plug-and-play architecture for AI providers; adding a new provider only requires implementing the `AIProvider` interface and adding its configuration.
    *   Simplifies the proxy logic, as it only needs to look up the provider in the registry and call its method.
    *   Enables A/B testing and performance comparisons between providers.
    *   Improves system resilience through automated fallback mechanisms.
*   **Negative**:
    *   Requires defining a rigid, standardized interface for all providers, which may need to be versioned if provider capabilities diverge significantly.
    *   Initial setup is more complex than a single hardcoded provider implementation.
