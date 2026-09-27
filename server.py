"""
arena2api - Arena.ai to OpenAI API Proxy
=========================================

Minimal design: the Chrome extension provides reCAPTCHA tokens and cookies,
while this server converts OpenAI-format requests and calls the arena.ai API.

Usage:
  1. pip install -r requirements.txt
  2. python server.py
  3. Install the Chrome extension and open arena.ai
  4. Configure http://localhost:9090/v1 in your OpenAI client
"""

import asyncio
import json
import logging
import os
import re
import secrets
import time
import uuid
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import Response, StreamingResponse, JSONResponse

# ============================================================
# Logging
# ============================================================
logging.basicConfig(
    level=logging.DEBUG if os.environ.get("DEBUG") else logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("arena2api")

# ============================================================
# Configuration
# ============================================================
PORT = int(os.environ.get("PORT", "9090"))
API_KEY = os.environ.get("API_KEY", "").strip()
ARENA_BASE = "https://arena.ai"
ARENA_CREATE_EVAL = f"{ARENA_BASE}/nextjs-api/stream/create-evaluation"
ARENA_POST_EVAL = f"{ARENA_BASE}/nextjs-api/stream/post-to-evaluation"  # + /{id}

# reCAPTCHA
RECAPTCHA_V3_SITEKEY = "6Led_uYrAAAAAKjxDIF58fgFtX3t8loNAK85bW9I"

# ============================================================
# UUIDv7
# ============================================================
def uuid7() -> str:
    ts = int(time.time() * 1000)
    ra = secrets.randbits(12)
    rb = secrets.randbits(62)
    u = ts << 80 | (0x7000 | ra) << 64 | (0x8000000000000000 | rb)
    h = f"{u:032x}"
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


# ============================================================
# Token / cookie store (received from the extension)
# ============================================================
class Store:
    def __init__(self):
        self.cookies: dict = {}
        self.auth_token: str = ""
        self.cf_clearance: str = ""
        self.v3_tokens: list = []  # [{token, action, ts}]
        self.used_v3_tokens: dict[str, float] = {}  # token -> consumed timestamp
        self.v2_token: Optional[dict] = None
        self.last_push: float = 0
        self.models: list = []
        self.text_models: dict = {}  # publicName -> id
        self.image_models: dict = {}
        self.vision_models: list = []
        self.next_actions: dict = {}  # action name -> hash
        self.bridge_jobs: list[dict] = []
        self.bridge_waiters: dict[str, asyncio.Future] = {}
        self.last_bridge_poll: float = 0

    @property
    def active(self) -> bool:
        return self.last_push > 0 and (time.time() - self.last_push < 120)

    @property
    def browser_bridge_active(self) -> bool:
        return time.time() - self.last_bridge_poll < 15

    def push(self, data: dict):
        self.last_push = time.time()
        now = time.time()
        self.used_v3_tokens = {
            token: consumed_at
            for token, consumed_at in self.used_v3_tokens.items()
            if now - consumed_at < 130
        }
        if data.get("cookies"):
            self.cookies = data["cookies"]
        if "auth_token" in data:
            self.auth_token = data.get("auth_token") or ""
        if data.get("cf_clearance"):
            self.cf_clearance = data["cf_clearance"]
        # V3 tokens
        if data.get("v3_tokens"):
            for t in data["v3_tokens"]:
                tok = t.get("token", "")
                if not tok or len(tok) < 20:
                    continue
                if tok in self.used_v3_tokens:
                    continue
                age = t.get("age_ms", 0)
                if age > 120000:
                    continue
                if any(x["token"] == tok for x in self.v3_tokens):
                    continue
                self.v3_tokens.append({
                    "token": tok,
                    "action": t.get("action", "chat_submit"),
                    "ts": time.time() - age / 1000,
                })
            while len(self.v3_tokens) > 10:
                self.v3_tokens.pop(0)
        # V2 token
        if data.get("v2_token"):
            v2 = data["v2_token"]
            if v2.get("token") and v2.get("age_ms", 0) < 120000:
                self.v2_token = {
                    "token": v2["token"],
                    "ts": time.time() - v2.get("age_ms", 0) / 1000,
                }
        # Models
        if data.get("models"):
            self._update_models(data["models"])
        # Next actions
        if data.get("next_actions"):
            self.next_actions.update(data["next_actions"])

    def _update_models(self, models: list):
        self.models = [m for m in models if isinstance(m, dict)]
        self.text_models = {}
        self.image_models = {}
        self.vision_models = []
        for m in self.models:
            name = m.get("publicName", "")
            mid = m.get("id", "")
            if not isinstance(name, str) or not name or not isinstance(mid, str) or not mid:
                continue
            caps = m.get("capabilities") or {}
            if not isinstance(caps, dict):
                continue
            out_caps = caps.get("outputCapabilities") or []
            in_caps = caps.get("inputCapabilities") or []
            if "text" in out_caps:
                self.text_models[name] = mid
            if "image" in out_caps:
                self.image_models[name] = mid
            if "image" in in_caps:
                self.vision_models.append(name)

    def pop_v3_token(self) -> Optional[str]:
        now = time.time()
        self.v3_tokens = [t for t in self.v3_tokens if now - t["ts"] < 120]
        if not self.v3_tokens:
            return None
        token = self.v3_tokens.pop(0)["token"]
        self.used_v3_tokens[token] = now
        return token

    def pop_v2_token(self) -> Optional[str]:
        if not self.v2_token:
            return None
        if time.time() - self.v2_token["ts"] > 120:
            self.v2_token = None
            return None
        tok = self.v2_token["token"]
        self.v2_token = None
        return tok

    def build_cookie_header(self) -> str:
        parts = []
        for k, v in self.cookies.items():
            parts.append(f"{k}={v}")
        return "; ".join(parts)

    def status(self) -> dict:
        now = time.time()
        valid_v3 = [t for t in self.v3_tokens if now - t["ts"] < 120]
        return {
            "active": self.active,
            "last_push_ago": round(now - self.last_push, 1) if self.last_push else None,
            "v3_tokens": len(valid_v3),
            "has_v2": bool(self.v2_token and now - self.v2_token["ts"] < 120),
            "has_auth": bool(self.auth_token),
            "has_cf": bool(self.cf_clearance),
            "text_models": len(self.text_models),
            "image_models": len(self.image_models),
            "next_actions": list(self.next_actions.keys()),
            "browser_bridge_active": self.browser_bridge_active,
            "cookies": list(self.cookies.keys()),
        }


store = Store()

# ============================================================
# FastAPI
# ============================================================
app = FastAPI(title="arena2api", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def verify_api_key(request: Request):
    """Optional API key auth for OpenAI endpoints.

    If API_KEY is set, require: Authorization: Bearer <API_KEY>
    """
    if not API_KEY:
        return

    auth_header = request.headers.get("authorization", "")
    expected = f"Bearer {API_KEY}"
    if auth_header != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


# ============================================================
# Extension endpoints
# ============================================================
@app.post("/v1/extension/push")
async def extension_push(request: Request):
    """Receive tokens, cookies, and models pushed by the extension."""
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    store.push(data)
    need = len([t for t in store.v3_tokens if time.time() - t["ts"] < 120]) < 3
    return {
        "status": "ok",
        "need_tokens": need,
        "v3_count": len(store.v3_tokens),
    }


@app.get("/v1/extension/status")
async def extension_status():
    return store.status()


@app.get("/v1/extension/job")
async def extension_job():
    """Long-lived extension polls this for work that must run in the page."""
    store.last_bridge_poll = time.time()
    if not store.bridge_jobs:
        return Response(status_code=204)
    return {"job": store.bridge_jobs.pop(0)}


@app.post("/v1/extension/job/{job_id}/result")
async def extension_job_result(job_id: str, request: Request):
    store.last_bridge_poll = time.time()
    try:
        result = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    waiter = store.bridge_waiters.get(job_id)
    if waiter and not waiter.done():
        waiter.set_result(result)
    return {"status": "ok"}


async def run_in_arena_page(payload: dict) -> dict:
    """Send an Arena call to the extension's page-context fetch bridge."""
    job_id = uuid7()
    waiter = asyncio.get_running_loop().create_future()
    store.bridge_waiters[job_id] = waiter
    store.bridge_jobs.append({"id": job_id, "payload": payload})
    try:
        return await asyncio.wait_for(waiter, timeout=330)
    except asyncio.TimeoutError:
        raise HTTPException(504, "Arena browser bridge timed out")
    finally:
        store.bridge_waiters.pop(job_id, None)


def parse_arena_body(raw: str) -> tuple[str, str, str]:
    """Extract text/reasoning/finish reason from Arena's event stream."""
    content_parts, reasoning_parts = [], []
    finish_reason = "stop"
    for line in raw.splitlines():
        if line.startswith("a0:"):
            try:
                value = json.loads(line[3:])
                if isinstance(value, str) and value != "hasArenaError":
                    content_parts.append(value)
            except json.JSONDecodeError:
                pass
        elif line.startswith("ag:"):
            try:
                value = json.loads(line[3:])
                if isinstance(value, str):
                    reasoning_parts.append(value)
            except json.JSONDecodeError:
                pass
        elif line.startswith("a2:") and "heartbeat" not in line:
            try:
                for image in json.loads(line[3:]):
                    if image.get("image"):
                        content_parts.append(f"![image]({image['image']})")
            except (json.JSONDecodeError, TypeError):
                pass
        elif line.startswith("ad:"):
            try:
                finish_reason = json.loads(line[3:]).get("finishReason") or finish_reason
            except json.JSONDecodeError:
                pass
        elif line.startswith("a3:"):
            content_parts.append(f"[Error: {line[3:]}]")
    return "".join(content_parts), "".join(reasoning_parts), finish_reason


def browser_completion(result: dict, model_name: str, eval_id: str) -> dict:
    status = result.get("status", 0)
    raw = result.get("body", "")
    if status != 200:
        raise HTTPException(status or 502, f"Arena browser request failed: {raw[:200]}")
    content, reasoning, finish_reason = parse_arena_body(raw)
    message = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "id": f"chatcmpl-{eval_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": {},
    }


async def browser_stream_response(result: dict, model_name: str, eval_id: str):
    completion = browser_completion(result, model_name, eval_id)
    message = completion["choices"][0]["message"]
    if message["content"]:
        chunk = {
            "id": completion["id"], "object": "chat.completion.chunk",
            "created": completion["created"], "model": model_name,
            "choices": [{"index": 0, "delta": {"content": message["content"]}, "finish_reason": None}],
        }
        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
    chunk = {
        "id": completion["id"], "object": "chat.completion.chunk",
        "created": completion["created"], "model": model_name,
        "choices": [{"index": 0, "delta": {}, "finish_reason": completion["choices"][0]["finish_reason"]}],
    }
    yield f"data: {json.dumps(chunk)}\n\ndata: [DONE]\n\n"


# ============================================================
# OpenAI-compatible endpoints
# ============================================================
@app.get("/v1/models")
async def list_models(request: Request):
    """List available models."""
    verify_api_key(request)
    all_models = {}
    all_models.update(store.text_models)
    all_models.update(store.image_models)
    data = []
    for name in sorted(all_models.keys()):
        data.append({
            "id": name,
            "object": "model",
            "created": 0,
            "owned_by": "arena.ai",
        })
    if not data:
        # Return a placeholder model.
        data.append({
            "id": "waiting-for-extension",
            "object": "model",
            "created": 0,
            "owned_by": "arena.ai",
        })
    return {"object": "list", "data": data}


def detect_client(request: Request) -> str:
    """Detect the client type."""
    ua = request.headers.get("user-agent", "").lower()
    if "claude" in ua or "anthropic" in ua:
        return "claude"
    if "gemini" in ua or "google" in ua:
        return "gemini"
    if "codex" in ua:
        return "codex"
    if "opencode" in ua:
        return "opencode"
    # NewAPI/OneAPI normally use the standard OpenAI format.
    return "openai"


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible chat completion."""
    verify_api_key(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")

    client_type = detect_client(request)
    model_name = body.get("model", "")
    messages = body.get("messages", [])
    stream = body.get("stream", False)

    if not messages:
        raise HTTPException(400, "messages is required")

    # Check whether the extension is connected.
    if not store.active:
        raise HTTPException(503, "Extension not connected. Please open arena.ai in Chrome with the extension installed.")

    # Resolve the model.
    model_id = store.text_models.get(model_name) or store.image_models.get(model_name)
    if not model_id:
        # Try a fuzzy match.
        for name, mid in {**store.text_models, **store.image_models}.items():
            if model_name.lower() in name.lower() or name.lower() in model_name.lower():
                model_id = mid
                model_name = name
                break
    if not model_id:
        available = list(store.text_models.keys()) + list(store.image_models.keys())
        raise HTTPException(404, f"Model '{model_name}' not found. Available: {available[:20]}")

    # Build the prompt (using the last user message).
    prompt = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, list):
                # Multimodal message.
                text_parts = [p.get("text", "") for p in content if p.get("type") == "text"]
                prompt = "\n".join(text_parts)
            else:
                prompt = content
            break
    if not prompt:
        prompt = messages[-1].get("content", "")

    # Prepend system messages to the prompt.
    system_parts = [m["content"] for m in messages if m.get("role") == "system"]
    if system_parts:
        prompt = "\n".join(system_parts) + "\n\n" + prompt

    # Include history for multi-turn conversations.
    if len(messages) > 1:
        history_parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if isinstance(content, list):
                content = "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
            if role == "system":
                continue  # Already handled.
            history_parts.append(f"<|{role}|>\n{content}")
        prompt = "\n".join(history_parts)

    is_image = model_name in store.image_models
    modality = "image" if is_image else "chat"

    # Build the arena.ai request.
    eval_id = uuid7()
    user_msg_id = uuid7()
    model_a_msg_id = uuid7()

    arena_payload = {
        "id": eval_id,
        # Arena's /text/direct route uses the internal direct-battle mode when
        # it creates a new conversation. Sending "direct" is rejected by the
        # current backend with: "direct mode is not allowed...".
        "mode": "direct-battle",
        "modelAId": model_id,
        "userMessageId": user_msg_id,
        "modelAMessageId": model_a_msg_id,
        "userMessage": {
            "content": prompt,
            "experimental_attachments": [],
            "metadata": {},
        },
        "modality": modality,
    }

    # When available, run the request in the Arena page itself. This preserves
    # the browser's real cookie, TLS, and reCAPTCHA context instead of copying
    # a browser token into a Python HTTP request.
    if store.browser_bridge_active:
        log.info(f"Sending through browser bridge: model={model_name}, eval_id={eval_id}")
        result = await run_in_arena_page(arena_payload)
        if stream:
            return StreamingResponse(
                browser_stream_response(result, model_name, eval_id),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )
        return browser_completion(result, model_name, eval_id)

    # Legacy fallback when an older extension is installed.
    v3_token = store.pop_v3_token()
    v2_token = store.pop_v2_token() if not v3_token else None
    if v2_token:
        arena_payload["recaptchaV2Token"] = v2_token
        arena_payload["recaptchaV3Token"] = None
    elif v3_token:
        arena_payload["recaptchaV3Token"] = v3_token
    else:
        log.warning("No reCAPTCHA token available, sending without token")

    # Build headers.
    headers = {
        "accept": "*/*",
        "content-type": "application/json",
        "origin": ARENA_BASE,
        "referer": f"{ARENA_BASE}/text/direct?model_a=max",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "cookie": store.build_cookie_header(),
    }

    # Authentication is carried by Arena's cookies, matching requests from
    # the web app. The arena-auth cookie is not always a bearer token; sending
    # it as Authorization can make Arena reject a valid session as an unknown
    # user.

    url = ARENA_CREATE_EVAL
    log.info(f"Sending to arena.ai: model={model_name}, eval_id={eval_id}, has_v3={bool(v3_token)}, has_v2={bool(v2_token)}")

    if stream:
        return StreamingResponse(
            stream_response(url, arena_payload, headers, model_name, eval_id, client_type),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    else:
        return await non_stream_response(url, arena_payload, headers, model_name, eval_id, client_type)


async def stream_response(url, payload, headers, model_name, eval_id, client_type="openai"):
    """Streaming response generator."""
    chat_id = f"chatcmpl-{eval_id}"
    created = int(time.time())

    try:
        async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    log.error(f"Arena API error: {resp.status_code} {body[:500]}")
                    error_chunk = {
                        "id": chat_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model_name,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": f"[Error: Arena API returned {resp.status_code}]"},
                            "finish_reason": "stop",
                        }],
                    }
                    yield f"data: {json.dumps(error_chunk)}\n\n"
                    yield "data: [DONE]\n\n"
                    return

                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue

                    content = None
                    reasoning = None
                    finish = None

                    if line.startswith("a0:"):
                        # Text content.
                        try:
                            content = json.loads(line[3:])
                            if content == "hasArenaError":
                                content = "[Arena Error]"
                                finish = "stop"
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("ag:"):
                        # Reasoning content.
                        try:
                            reasoning = json.loads(line[3:])
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("ad:"):
                        # Completion.
                        finish = "stop"
                        try:
                            data = json.loads(line[3:])
                            if data.get("finishReason"):
                                finish = data["finishReason"]
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a2:"):
                        # Heartbeat or image.
                        if "heartbeat" in line:
                            continue
                        try:
                            data = json.loads(line[3:])
                            images = [img.get("image") for img in data if img.get("image")]
                            if images:
                                content = "\n".join(f"![image]({url})" for url in images)
                        except json.JSONDecodeError:
                            continue
                    elif line.startswith("a3:"):
                        # Error.
                        try:
                            content = f"[Error: {json.loads(line[3:])}]"
                        except:
                            content = f"[Error: {line[3:]}]"
                        finish = "stop"
                    else:
                        continue

                    if content is not None:
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {"content": content},
                                "finish_reason": None,
                            }],
                        }
                        # Claude/Anthropic format compatibility.
                        if client_type == "claude":
                            chunk["type"] = "content_block_delta"
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                    if reasoning is not None:
                        # Return reasoning as regular content (or use reasoning_content).
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {"reasoning_content": reasoning},
                                "finish_reason": None,
                            }],
                        }
                        yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                    if finish:
                        chunk = {
                            "id": chat_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model_name,
                            "choices": [{
                                "index": 0,
                                "delta": {},
                                "finish_reason": finish if finish != "stop" else "stop",
                            }],
                        }
                        yield f"data: {json.dumps(chunk)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

    except Exception as e:
        log.error(f"Stream error: {e}")
        error_chunk = {
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{
                "index": 0,
                "delta": {"content": f"[Stream Error: {e}]"},
                "finish_reason": "stop",
            }],
        }
        yield f"data: {json.dumps(error_chunk)}\n\n"
        yield "data: [DONE]\n\n"


async def non_stream_response(url, payload, headers, model_name, eval_id, client_type="openai"):
    """Non-streaming response."""
    content_parts = []
    reasoning_parts = []
    finish_reason = "stop"
    usage = {}

    try:
        async with httpx.AsyncClient(timeout=300, follow_redirects=True) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    body = await resp.aread()
                    log.error(f"Arena API error: {resp.status_code} {body[:500]}")
                    raise HTTPException(resp.status_code, f"Arena API error: {body[:200]}")

                async for line in resp.aiter_lines():
                    if not line.strip():
                        continue
                    if line.startswith("a0:"):
                        try:
                            text = json.loads(line[3:])
                            if isinstance(text, str) and text != "hasArenaError":
                                content_parts.append(text)
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("ag:"):
                        try:
                            text = json.loads(line[3:])
                            if isinstance(text, str):
                                reasoning_parts.append(text)
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("ad:"):
                        try:
                            data = json.loads(line[3:])
                            if data.get("finishReason"):
                                finish_reason = data["finishReason"]
                            if data.get("usage"):
                                usage = data["usage"]
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a2:"):
                        if "heartbeat" in line:
                            continue
                        try:
                            data = json.loads(line[3:])
                            images = [img.get("image") for img in data if img.get("image")]
                            for img_url in images:
                                content_parts.append(f"![image]({img_url})")
                        except json.JSONDecodeError:
                            pass
                    elif line.startswith("a3:"):
                        try:
                            content_parts.append(f"[Error: {json.loads(line[3:])}]")
                        except:
                            content_parts.append(f"[Error: {line[3:]}]")

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Non-stream error: {e}")
        raise HTTPException(500, str(e))

    full_content = "".join(content_parts)
    full_reasoning = "".join(reasoning_parts)

    message = {"role": "assistant", "content": full_content}
    if full_reasoning:
        message["reasoning_content"] = full_reasoning

    response = {
        "id": f"chatcmpl-{eval_id}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": usage or {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }

    # Claude format compatibility.
    if client_type == "claude":
        response["type"] = "message"
        response["role"] = "assistant"
        response["content"] = [{"type": "text", "text": full_content}]

    return response


# ============================================================
# Health check
# ============================================================
@app.get("/health")
@app.get("/")
async def health():
    return {
        "status": "ok",
        "version": "1.0.0",
        "extension": store.status(),
    }


# ============================================================
# Startup
# ============================================================
if __name__ == "__main__":
    log.info(f"Starting arena2api on port {PORT}")
    log.info(f"OpenAI API: http://localhost:{PORT}/v1")
    log.info("Waiting for Chrome extension to connect...")
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
