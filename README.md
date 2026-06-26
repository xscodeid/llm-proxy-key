# 🚀 LLM Proxy Key
![Express.js](https://img.shields.io/badge/express.js-%23404d59.svg?style=for-the-badge&logo=express&logoColor=%2361DAFB) ![Nodemon](https://img.shields.io/badge/NODEMON-%23323330.svg?style=for-the-badge&logo=nodemon&logoColor=%BBDEAD) ![NPM](https://img.shields.io/badge/NPM-%23CB3837.svg?style=for-the-badge&logo=npm&logoColor=white) ![TypeScript](https://img.shields.io/badge/typescript-%23007ACC.svg?style=for-the-badge&logo=typescript&logoColor=white) 

---

<div style="text-align: center;">
![LLM Proxy Key](logo-512px.png)
</div>

> 🔄 A multi-provider AI API key proxy with round-robin rotation. Routes requests to different upstream providers based on URL path prefix. Each provider has its own endpoint, API key pool, model whitelist, and format configuration.

---

## ✨ Features

- 🌐 **Multi-Provider Routing** — Route requests to different APIs via URL prefix (`/kilo/v1/...`, `/openrouter/v1/...`)
- 🔑 **Per-Provider Key Rotation** — Each provider has its own pool of API keys with round-robin rotation
- 🛡️ **Per-Provider Model Whitelist** — Control which models are allowed per provider
- 🔁 **API Format Mapping** — Automatic conversion between OpenAI and Anthropic API formats
- 📡 **Streaming Support** — Full SSE streaming with retry on initial fetch failure
- 📊 **Token Tracking** — Real-time token usage monitoring and logging
- 🔐 **Proxy Authentication** — Optional static API key to protect the proxy endpoint
- 🌍 **CORS Ready** — Built-in CORS handling for web applications
- 🐳 **Docker Ready** — Production-optimized image

---

## ⚡ Quick Start

```bash
# 📦 Install dependencies
npm install

# ⚙️ Configure environment
cp .env.example .env
nano .env

# 🚀 Start development server
npm start
```

---

## 🔧 Configuration

Create a `.env` file with your provider configurations. Each provider uses a prefix (e.g. `KILO_`, `OPENROUTER_`) and is accessed via a URL path matching the lowercase prefix:

```env
# === 🔵 KILO PROVIDER ===
# Access via: http://localhost:8888/kilo/v1/...
KILO_ENDPOINT=https://api.kilo.ai/api/gateway
KILO_FORMAT=openai
KILO_MODELS=deepseek/deepseek-v4-flash
KILO_API_KEYS_1=your-first-key
KILO_API_KEYS_2=your-second-key

# === 🟢 OPENROUTER PROVIDER ===
# Access via: http://localhost:8888/openrouter/v1/...
# OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1
# OPENROUTER_FORMAT=openai
# OPENROUTER_MODELS=google/gemini-2.0-flash-001,anthropic/claude-3.5-sonnet
# OPENROUTER_API_KEYS_1=your-first-key

# === 🌍 GLOBAL ===
PROXY_AUTH_KEY=your-proxy-auth-key
PORT=8888
```

### 🧭 How Provider Routing Works

The URL path prefix determines which provider handles the request. The prefix is stripped before forwarding to the upstream API:

| Client Request | Provider | Upstream Request |
|---|---|---|
| `POST /kilo/v1/chat/completions` | 🔵 KILO | `POST {KILO_ENDPOINT}/v1/chat/completions` |
| `POST /openrouter/v1/chat/completions` | 🟢 OPENROUTER | `POST {OPENROUTER_ENDPOINT}/v1/chat/completions` |
| `POST /kilo/v1/messages` | 🔵 KILO | `POST {KILO_ENDPOINT}/v1/messages` |

---

### 📋 Environment Variables

#### Per-Provider Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PREFIX_ENDPOINT` | ✅ Yes | Upstream API base URL |
| `PREFIX_FORMAT` | ❌ No | API format: `openai` or `anthropic` (default: `openai`) |
| `PREFIX_MODELS` | ❌ No | Comma-separated model whitelist (empty = allow all) |
| `PREFIX_API_KEYS_1` | ✅ Yes | First API key for rotation |
| `PREFIX_API_KEYS_2`+ | ❌ No | Additional API keys for rotation |

#### Global Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `PROXY_AUTH_KEY` | ❌ No | Static key to protect proxy access (empty = no auth) | - |
| `PORT` | ❌ No | Server port | `8888` |

---

### ➕ Adding a New Provider

To add a new provider, create env vars with a new prefix. No code changes needed — the proxy auto-discovers providers from env:

```env
# === 🟢 OPENROUTER PROVIDER ===
# Access via: http://localhost:8888/openrouter/v1/...
OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1
OPENROUTER_FORMAT=openai
OPENROUTER_MODELS=google/gemini-2.0-flash-001,anthropic/claude-3.5-sonnet
OPENROUTER_API_KEYS_1=your-first-key
OPENROUTER_API_KEYS_2=your-second-key
```

---

## 💡 Usage

### 🔵 Kilo Provider (OpenAI Format)

```bash
curl -X POST http://localhost:8888/kilo/v1/chat/completions \
  -H "Authorization: Bearer your-proxy-auth-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek/deepseek-v4-flash",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### 🔵 Kilo Provider (Anthropic Format)

```bash
curl -X POST http://localhost:8888/kilo/v1/messages \
  -H "Authorization: Bearer your-proxy-auth-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-3.5-sonnet",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### 🤖 Claude Code Integration

```bash
export ANTHROPIC_BASE_URL=http://localhost:8888/kilo
claude
```

### 📦 JavaScript / TypeScript (OpenAI SDK)

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8888/kilo",
  apiKey: "your-proxy-auth-key",
});

const response = await client.chat.completions.create({
  model: "deepseek/deepseek-v4-flash",
  messages: [{ role: "user", content: "Hello!" }],
});
```

---

## 🏗️ Architecture

```
app.ts                          # 🚀 Entry point: load providers, per-provider key rotation, route requests
routes/
  proxy.ts                      # 🎯 Main handler: auth, validate model, map format, retry, forward
  providerRouter.ts             # 🧭 Resolve URL path → provider config (longest prefix match)
services/
  providerRegistry.ts           # 🔍 Auto-discover providers from env vars (PREFIX_ENDPOINT, etc.)
  nonStreamingRequest.ts        # 📤 Non-streaming upstream handler
  streamingRequest.ts           # 📡 Streaming upstream handler (SSE)
utils/
  apiMapper.ts                  # 🔁 OpenAI ↔ Anthropic format conversion
  formatDetector.ts             # 🔎 Detect client API format from path/body
  tokenUsage.ts                 # 📊 Extract and log token usage from response chunks
types/
  api.ts                        # 📝 API format types (OpenAIRequest, AnthropicRequest, etc.)
  provider.ts                   # ⚙️ ProviderConfig interface
  index.ts                      # 📋 Shared types (TokenUsage)
config/
  server.ts                     # ⏱️ Server timeout configuration (5 min for streaming)
middleware/
  cors.ts                       # 🌍 CORS handling
```

---

## 🔄 API Key Rotation

Each provider maintains its own key pool with round-robin rotation:

```
Request 1 → 🔑 KILO_API_KEYS_1
Request 2 → 🔑 KILO_API_KEYS_2
Request 3 → 🔑 KILO_API_KEYS_3
Request 4 → 🔑 KILO_API_KEYS_1  (cycles back)
```

On retryable errors (429, 5xx), the failed key is excluded and the next key is used.

---

## ❌ Error Handling

| Status | Condition |
|--------|-----------|
| 400 | ⚠️ Missing model or model not in whitelist |
| 401 | 🔒 Missing Authorization header |
| 403 | 🚫 Invalid proxy auth key |
| 404 | 🔍 No provider matches the request path |
| 500 | 💥 All retries exhausted or internal error |

---

## 🐳 Docker

```bash
# 🏗️ Build and run
docker-compose up -d

# 📜 View logs
docker-compose logs -f

# 🛑 Stop
docker-compose down
```

The Docker image runs the compiled production build (`node build/app.js`) with a non-root user.

---

## 🛠️ Development

```bash
# 📦 Install dependencies
npm install

# 🔄 Start with hot reload (nodemon)
npm start

# 🏗️ Build for production
npm run build

# 🚀 Run production build
node build/app.js
```

---

## 🤝 Contributing

We welcome contributions from everyone! Here's how you can contribute to this project:

### 🚀 Getting Started

1. **Fork** this repository
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/llm-proxy-key.git
   cd llm-proxy-key
   ```
3. **Create a branch** for your feature or bugfix:
   ```bash
   git checkout -b feature/your-feature-name
   ```
4. **Install dependencies**:
   ```bash
   npm install
   ```
5. **Make your changes** and ensure the code remains clean and structured
6. **Commit** your changes with a clear message:
   ```bash
   git commit -m "feat: add new provider support"
   ```
7. **Push** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
8. **Open a Pull Request** to the main repository

### 📝 Contribution Guidelines

- ✅ Use strict TypeScript with proper type definitions
- ✅ Follow the existing code conventions and style
- ✅ Add comments for complex logic
- ✅ Never hardcode sensitive values (API keys, passwords, etc.)
- ✅ Ensure backward compatibility
- ✅ Test your changes before submitting a PR

### 🐛 Reporting Bugs

If you find a bug, please open an [Issue](https://github.com/OWNER/llm-proxy-key/issues) with the following format:

- **Title**: Brief description of the bug
- **Steps to reproduce**: How to trigger the bug
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Environment**: OS, Node.js version, etc.

### 💡 Feature Requests

If you have an idea for a new feature, please open an [Issue](https://github.com/OWNER/llm-proxy-key/issues) with the `feature-request` label and describe:

- What feature you want
- Use case / why it's needed
- Possible implementation approach (optional)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.
