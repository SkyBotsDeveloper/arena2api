# arena2api

Expose the 300+ models available on [arena.ai](https://arena.ai) through an **OpenAI-compatible API**.

## Project Ownership

Maintained and credited to [SkyBotsDeveloper](https://github.com/SkyBotsDeveloper).

## How It Works

```text
OpenAI client ── OpenAI-format request ──> Python proxy (localhost:9090)
Browser extension ── tokens, cookies, models ──> Python proxy
Python proxy ── authenticated arena.ai request ──> arena.ai
Python proxy <── arena.ai SSE stream <────────── arena.ai
OpenAI client <── OpenAI SSE response <──────── Python proxy
```

The browser extension runs on an arena.ai page. It collects authenticated browser cookies, discovers available models from Next.js data, and obtains reCAPTCHA tokens in the real browser environment. The Python server translates requests and responses between arena.ai and the OpenAI API format.

The extension's scripts communicate as follows:

```text
injector.js (MAIN world) <-> content.js (ISOLATED world) <-> background.js
```

`injector.js` can access page globals such as `grecaptcha` and Next.js data. `content.js` bridges messages, and `background.js` manages cookies, tokens, and server synchronization.

## Key Details

| Feature | Description |
| --- | --- |
| reCAPTCHA V3 handling | The extension calls `grecaptcha.enterprise.execute()` in a real browser to obtain short-lived tokens. |
| Dual-world injection | The page script accesses page globals; the content script accesses browser extension APIs. |
| Fragmented cookies | Auth cookies such as `arena-auth-prod-v1.0` and `.1` are automatically combined. |
| Token pool | Up to 10 V3 tokens are kept, replenished every 80 seconds, and expired tokens are removed. |
| SSE conversion | arena.ai events (`a0:`, `ag:`, `ad:`, `a2:`, and `a3:`) are converted to standard OpenAI SSE chunks. |
| Automatic model discovery | Models are extracted from Next.js `__NEXT_DATA__` or `__next_f` data. |

## Quick Start

### Prerequisites

- Python 3.10+
- Chrome or Firefox
- An [arena.ai](https://arena.ai) account

### 1. Start the server

```bash
pip install -r requirements.txt
python server.py
```

The server listens on `http://localhost:9090` by default and waits for an extension connection.

### 2. Install the browser extension

#### Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this project's `extension/` directory.

#### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose `extension-firefox/manifest.json` from this project.

### 3. Connect to arena.ai

1. Click the extension icon and select **Open Arena.ai**, or open `https://arena.ai/?mode=direct`.
2. Wait 3–5 seconds for the page to load.
3. Open the extension popup again and verify that Server is connected, the Arena tab is active, the auth cookie is present, and models have been found.

### 4. Call the API

```bash
# List available models
curl http://localhost:9090/v1/models

# Non-streaming chat
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"GPT-4o","messages":[{"role":"user","content":"Hello"}]}'

# Streaming chat
curl http://localhost:9090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"GPT-4o","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

### Use with the OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9090/v1", api_key="not-needed")
response = client.chat.completions.create(
    model="GPT-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

## API Endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/v1/models` | GET | Lists all available models in OpenAI format. |
| `/v1/chat/completions` | POST | Creates a chat completion; supports `stream: true` and `false`. |
| `/v1/extension/push` | POST | Internal endpoint used by the extension to push tokens, cookies, and models. |
| `/v1/extension/status` | GET | Shows extension connection status and token-pool information. |
| `/health` | GET | Health check. |

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PORT` | `9090` | Port on which the server listens. |
| `API_KEY` | none | Optional authentication; requests must send `Authorization: Bearer <API_KEY>`. |
| `DEBUG` | none | Set any value to enable debug logging. |

Click the extension icon to change **Server URL**. Its default is `http://127.0.0.1:9090`.

## Project Structure

```text
arena2api/
├── server.py              # FastAPI proxy and OpenAI/arena.ai conversion
├── requirements.txt       # Python dependencies
├── extension/             # Chrome extension (Manifest V3)
│   ├── background.js      # Token pool, cookie refresh, and periodic server push
│   ├── content.js         # Injector-to-background message bridge
│   ├── injector.js        # reCAPTCHA access, model discovery, and cookie reading
│   └── popup.html/js      # Extension popup UI
└── extension-firefox/     # Firefox extension (Manifest V2)
```

## Troubleshooting

### The extension shows Disconnected

Confirm that the Python server is running and that the port in Server URL is correct. The extension pushes automatically every 30 seconds; use the **Push** button to trigger it manually.

### The model list is empty

Ensure that the arena.ai page has fully loaded, then refresh it. Models are extracted from the page's Next.js data.

### A request returns 503

The server considers the extension disconnected after 120 seconds without a push. Check that the arena.ai tab remains open, or reopen the page.

### Requests fail because no token is available

reCAPTCHA tokens are valid for roughly two minutes and are replenished every 80 seconds. If a burst of requests consumes the pool, wait briefly for a new token.

## Notes

- Keep an arena.ai tab open: the extension needs its page environment to obtain reCAPTCHA tokens.
- Tokens last for about two minutes; high request volume can temporarily exhaust the pool.
- arena.ai is free to use; this project only converts protocol formats.
- Use arena.ai's original model names, such as `GPT-4o` and `Claude 3.5 Sonnet`. Call `/v1/models` for the complete list.
- This project is intended for local use. The server listens on `0.0.0.0` by default, so protect it appropriately in a production network.
