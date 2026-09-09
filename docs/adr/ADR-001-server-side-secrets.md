# 001. Server-Side Secret Management for AI Providers

**Status**: Accepted

**Context**:
The current implementation exposes AI provider API keys on the client-side, creating a critical security vulnerability. This allows unauthorized users to potentially access and misuse our AI provider accounts, leading to significant cost and security risks. The Master Implementation Plan (Week 1) requires immediate remediation of this issue.

**Decision**:
1.  All AI provider API keys and sensitive configuration will be moved from client-side code to server-side environment variables.
2.  A new, authenticated server-side AI proxy endpoint (`/api/ai/proxy`) will be created.
3.  The client-side application will make all AI-related requests to this proxy endpoint.
4.  The proxy will be responsible for securely attaching the appropriate API keys and forwarding the request to the respective AI provider (OpenAI, Claude, etc.).
5.  The server will manage a registry of AI providers and their configurations, loaded securely from environment variables.

**Consequences**:
*   **Positive**:
    *   Eliminates the critical security risk of exposing API keys on the client.
    *   Centralizes AI provider configuration, making it easier to manage, rotate keys, and add new providers.
    *   Enables server-side control over AI usage, allowing for the implementation of rate limiting, cost tracking, and unified logging.
    *   Provides a single point of contact for all AI requests, simplifying the client-side implementation.
*   **Negative**:
    *   Introduces a small amount of additional latency for AI requests due to the extra hop through the server-side proxy. This will be monitored and optimized.
    *   Requires a refactor of all existing client-side code that directly calls AI providers.
