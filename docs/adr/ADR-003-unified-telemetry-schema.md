# 003. Unified Telemetry Schema

**Status**: Accepted

**Context**:
To effectively measure the success of the new AI features, track costs, and monitor performance, a consistent and structured telemetry system is required. The current system has fragmented or mock telemetry, making it impossible to generate reliable dashboards for our OKRs (accuracy, cost, performance). The Master Implementation Plan (Week 1) identifies this as a foundational task.

**Decision**:
1.  A unified, event-based telemetry schema will be adopted for all client-side and server-side events.
2.  A central `TelemetryService` will be implemented for capturing and forwarding these events to a persistent backend (e.g., SQLite/Postgres for now, scalable to a dedicated service later).
3.  Key events to be tracked include:
    *   `ai_suggestion_requested`: (provider, context, user_id)
    *   `ai_suggestion_responded`: (provider, latency_ms, cost_usd, suggestion_id, accuracy_score)
    *   `ai_suggestion_accepted`: (suggestion_id, user_id)
    *   `feature_used`: (feature_name, user_id)
    *   `page_viewed`: (page_name, load_time_ms)
    *   `error_occurred`: (service, error_code, details)
4.  All events will share a common envelope with metadata like `timestamp`, `user_id`, `session_id`, and `app_version`.

**Consequences**:
*   **Positive**:
    *   Enables the creation of consistent and reliable dashboards for tracking all key OKRs.
    *   Provides a structured way to analyze user behavior, feature adoption, and system performance.
    *   Decouples the application code from the specific telemetry backend, allowing for easier future upgrades.
*   **Negative**:
    *   Requires instrumenting code across the application, which is an upfront effort.
    *   Increases the volume of network requests and data storage, which needs to be managed.
