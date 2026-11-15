# Help Chat System Guide

## Overview

The Help Chat system provides an AI-powered documentation assistant that helps users find information about the Integration Hub platform. It uses Retrieval-Augmented Generation (RAG) to answer questions based on the project's documentation.

## Features

- **Natural Language Interface**: Ask questions in plain English
- **Documentation-Aware**: Searches through indexed project documentation
- **Contextual Responses**: Provides answers with source references
- **Session Management**: Maintains conversation history
- **Real-time Indexing**: Auto-indexes documentation on startup

## How It Works

### Architecture

```
User Question → RAG System → AI Provider → Response with Sources
                    ↓
            Documentation Index
```

1. **Question Processing**: User submits a question via the Help Chat widget
2. **Document Retrieval**: System finds relevant documentation chunks using semantic search
3. **Context Building**: Retrieved chunks are formatted as context for the AI
4. **AI Generation**: Provider generates a response based on the documentation context
5. **Response Delivery**: User receives answer with source references

### Provider Selection

**Important**: The Help Chat system currently uses the **Provider Registry fallback system** rather than task-specific configuration. This means:

- Help Chat does NOT respect individual task provider assignments in the AI Configuration Dashboard
- It uses the provider fallback order: `openai` → `claude` → `lmstudio` → `mock-openai` → `mock-claude` → `rule-based`
- The first available provider in this order is used automatically
- You cannot currently set a specific provider for Help Chat independently from other tasks

**Provider Fallback Behavior:**

| Provider | Status | Priority | Usage |
|----------|--------|----------|-------|
| OpenAI | If API key configured | 1st | Preferred provider |
| Claude | If API key configured | 2nd | Fallback #1 |
| LMStudio | If server running | 3rd | Fallback #2 |
| Mock OpenAI | Always available | 4th | Demo fallback #1 |
| Mock Claude | Always available | 5th | Demo fallback #2 |
| Rule-Based | Always available | 6th | Final fallback |

**To check which provider Help Chat is using:**
1. Check server logs for "Help chat provider call" messages showing the providerId
2. Look for "Using database-configured provider" or "Using registry fallback" in logs
3. If using environment-based providers (with API keys in `.env`), those take priority

## Using the Help Chat Widget

### Accessing Help Chat

The Help Chat widget appears as a blue floating button in the bottom-right corner of most dashboards.

**Available on:**
- AI Configuration Dashboard
- AI Field Mapping Editor
- Integration Dashboard Enhanced
- Executive Dashboards
- ROI Dashboard
- And many more pages

### Widget Interface

**Header:**
- **Help Assistant** title
- **Status Badge**: Shows documentation indexing status
  - 🟢 "Ready" - Documentation indexed and ready
  - 🟡 "Indexing" - Still processing documentation
- **Refresh Button**: Manually refresh indexing status
- **Reindex Button**: Trigger full documentation re-indexing
- **Resize Button**: Toggle between medium/large panel sizes
- **Clear Button**: Clear conversation history

**Chat Area:**
- **Welcome Message**: Shown when starting a new conversation
- **Message History**: Your questions and AI responses
- **Source References**: Click to view source documentation
- **Timestamps**: When each message was sent

**Input Area:**
- **Message Input**: Type your question
- **Send Button**: Submit question
- **Keyboard Shortcut**: Press Enter to send

### Example Questions

```
"How do I set up NetSuite?"
"What AI providers are available?"
"How does field mapping work?"
"How do I configure authentication?"
"What is the RAG knowledge base?"
"How do I monitor AI usage?"
```

### Tips for Best Results

1. **Be Specific**: Ask about specific features or configurations
2. **Use Keywords**: Mention specific systems (NetSuite, Salesforce, etc.)
3. **Check Sources**: Click source links to verify information
4. **Refine Questions**: If the answer isn't helpful, rephrase your question
5. **Wait for Indexing**: If docs are still indexing, wait for "Ready" status

## Documentation Indexing

### How Indexing Works

1. **Startup**: Documentation indexing begins automatically when server starts
2. **File Processing**: All `.md` files in `/docs` are chunked and embedded
3. **Vector Storage**: Embeddings stored for semantic search
4. **Status Tracking**: Progress shown in widget status badge

### Indexing Status

**Check indexing status:**
```bash
GET /api/help/status
```

**Response:**
```json
{
  "success": true,
  "data": {
    "ready": true,
    "stats": {
      "totalDocs": 245,
      "totalChunks": 1847,
      "avgChunkSize": 512
    },
    "progress": {
      "status": "completed",
      "indexed": 245,
      "total": 245
    }
  }
}
```

### Manual Reindexing

**When to reindex:**
- After adding new documentation
- After major doc updates
- If search results seem outdated

**How to reindex:**
1. Click the **Reindex** button in widget header
2. Wait for "Indexing..." status to complete
3. Status changes to "Ready" when done

**Via API:**
```bash
POST /api/help/reindex
```

## API Reference

### Send Help Chat Message

```http
POST /api/help/chat
Content-Type: application/json

{
  "message": "How do I configure NetSuite?",
  "sessionId": "optional-session-id"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "response": "To configure NetSuite, you need to...",
    "sources": [
      {
        "filePath": "docs/tutorials/NETSUITE-SETUP-GUIDE.md",
        "title": "NetSuite Setup Guide",
        "section": "OAuth 1.0 Configuration",
        "similarity": 0.89
      }
    ],
    "sessionId": "uuid-session-id",
    "timestamp": "2025-11-04T19:30:00.000Z"
  }
}
```

### Check Indexing Status

```http
GET /api/help/status
```

### Trigger Reindexing

```http
POST /api/help/reindex
```

## Configuration

### Environment Variables

```bash
# No specific env vars required for Help Chat
# Inherits AI provider configuration from main app
```

### Provider Configuration

Help Chat uses the Provider Registry's automatic fallback system. To ensure optimal performance:

1. **Set API keys in `.env`** for real providers:
   ```bash
   OPENAI_API_KEY=sk-...
   ANTHROPIC_API_KEY=sk-ant-...
   ```

2. **Configure LMStudio** (optional):
   ```bash
   LMSTUDIO_BASE_URL=http://localhost:1234
   ```

3. **Restart server** to apply changes

### Knowledge Base Settings

Located in `DocumentationKnowledgeBase.ts`:

```typescript
{
  chunkSize: 1000,           // Characters per chunk
  chunkOverlap: 200,         // Overlap between chunks
  minSimilarity: 0.5,        // Minimum similarity score
  maxResults: 5              // Max chunks retrieved
}
```

## Troubleshooting

### "Documentation still indexing" Message

**Problem**: Widget shows yellow "Indexing" status

**Solution**:
1. Wait 30-60 seconds for indexing to complete
2. Click Refresh button to check status
3. If stuck, click Reindex button to restart

**Check logs:**
```bash
# Look for:
[HelpChat] Documentation indexing complete
```

### No Responses or Errors

**Problem**: Questions return errors or no response

**Checklist**:
1. ✅ Documentation indexing complete (status shows "Ready")
2. ✅ At least one AI provider configured
3. ✅ API keys valid (if using OpenAI/Claude)
4. ✅ LMStudio running (if using local AI)

**Check provider status:**
```bash
# Server logs show which provider is being used
[HelpChat] Using provider: openai
```

### Wrong or Outdated Answers

**Problem**: Responses don't match current documentation

**Solution**:
1. Click **Reindex** button in widget
2. Wait for indexing to complete
3. Try question again

### Widget Not Appearing

**Problem**: Help Chat button missing from page

**Verification**:
1. Check if page includes Help Chat widget script
2. Look in browser console for errors
3. Verify `/components/help-chat-widget.js` loads

**Add to page** (if missing):
```html
<script src="/components/help-chat-widget.js"></script>
<div id="help-chat-widget-container"></div>
<script>
  document.addEventListener('alpine:init', () => {
    fetch('/help-chat-widget.html')
      .then(response => response.text())
      .then(html => {
        document.getElementById('help-chat-widget-container').innerHTML = html;
      });
  });
</script>
```

## Limitations

### Current Limitations

1. **Provider Configuration**: Cannot set Help Chat provider independently from other tasks
2. **Provider Display**: Widget does not show which provider is currently in use
3. **Session Persistence**: Sessions expire after 15 minutes of inactivity
4. **Documentation Scope**: Only indexes `/docs` directory
5. **Language**: English only

### Future Enhancements

- [ ] Task-specific provider configuration for Help Chat
- [ ] Provider name display in widget header
- [ ] Persistent session storage
- [ ] Multi-language support
- [ ] Custom documentation directories
- [ ] Advanced search filters
- [ ] Chat history export

## Security Considerations

### Data Privacy

- **Session Data**: Stored in memory, expires after 15 minutes
- **API Keys**: Never exposed in responses
- **Documentation**: Public docs only (no sensitive data indexed)
- **User Queries**: Logged for debugging (can be disabled)

### API Security

- **Authentication**: Uses session-based auth (if enabled)
- **Rate Limiting**: Inherits from global rate limiter
- **Input Validation**: Questions sanitized before processing

## Performance

### Indexing Performance

| Docs Count | Chunks | Indexing Time | Memory Usage |
|------------|--------|---------------|--------------|
| 100 docs | ~750 chunks | 10-15 sec | ~50 MB |
| 250 docs | ~1850 chunks | 20-30 sec | ~120 MB |
| 500 docs | ~3700 chunks | 40-60 sec | ~240 MB |

### Query Performance

- **Vector Search**: 50-100ms
- **AI Generation**: 1-3 seconds (depends on provider)
- **Total Response**: 2-4 seconds typical

### Optimization Tips

1. **Chunk Size**: Increase for faster indexing, decrease for better accuracy
2. **Max Results**: Lower for faster responses, higher for more context
3. **Similarity Threshold**: Higher for more precise results, lower for broader matches

## Related Documentation

- [AI Configuration Guide](../tutorials/comprehensive-ai-configuration-guide.md)
- [RAG Knowledge Base Guide](../tutorials/22-rag-knowledge-base-guide.md)
- [AI Provider Setup](../tutorials/ai-provider-configuration-guide.md)
- [Phase 4 RAG Implementation](../ai/PHASE-4-ACCURACY-IMPROVEMENTS.md)

## Support

For issues or questions:
1. Check server logs for error messages
2. Review [Troubleshooting Guide](../developer/troubleshooting.md)
3. Search existing documentation via Help Chat
4. Open GitHub issue with reproduction steps
