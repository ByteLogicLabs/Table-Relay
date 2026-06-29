# AI assistant

The assistant chats about your schema and data and can help you write and run
queries. **It can never run anything against your database without your
approval** - read [AI safety](ai-safety.md) for the full sandbox model. This page
is about setup and use.

## Pick a provider

AI is optional and configured in-app (no environment variables). Open
**Settings → AI Providers**, add a credential, and activate it. Provider types:

### Hosted

| Provider | Needs |
|---|---|
| **OpenAI** | API key |
| **Anthropic** | API key |
| **Google Gemini** | API key |
| **OpenAI-compatible** | Base URL (+ key if required) - Ollama, Groq, LM Studio, etc. |

API keys are stored locally and encrypted at rest (see
[the encrypted store](../dev/store-encryption.md)). They're sent only to the
provider you configured.

### Local (on-device)

Pick **Local Llama** - no key, no account, **nothing leaves your machine.**

1. Install the open-source [`llama.cpp`](https://github.com/ggerganov/llama.cpp)
   `llama-server` CLI first (for example `brew install llama.cpp`).
2. Download a model from the built-in catalog (Qwen2.5-Coder **3B / 7B / 14B**),
   or point it at a custom GGUF URL.
3. Table Relay launches `llama-server` for you and talks to it locally.

Rough RAM guidance from the model catalog: 3B ≈ 6 GB, 7B ≈ 8 GB, 14B ≈ 16 GB.
Downloads resume and are SHA-256 verified.

### CLI providers

Drive a coding agent you've already installed and logged in: **Claude Code,
Codex, Gemini CLI, opencode, Kilo, or Antigravity.** Log in to the tool in your
terminal as usual; Table Relay only invokes the binary you authenticated, never
reads or stores those credentials, and usage is billed to your own account.

## Using it

- Conversations and the chosen model/provider are saved **per conversation** and
  restored across restarts.
- Chat history is manageable and can be bulk-deleted.
- The assistant reads your schema to ground its answers. When it wants to run a
  query, an **Approve / Deny card** appears showing the exact statement - see
  [AI safety](ai-safety.md).

## What can call tools?

Only some providers run the in-app tool loop (where the model itself calls
`call_query` etc.): **OpenAI, OpenAI-compatible, and Local Llama** support tools
directly. **Anthropic** and **Gemini** are used in streaming chat mode here.
**CLI providers** run their own agent loop and reach the database through the
[MCP bridge](../dev/ai-internals.md#mcp-bridge) - which enforces the same
approval gates.

## Related

- [AI safety](ai-safety.md) - the approval model, in detail
- Developer detail: [AI internals](../dev/ai-internals.md)
