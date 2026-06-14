# pifm

A [pi-coding-agent](https://pi.dev) provider extension that routes pi to **Apple Foundation Models** via the `fm` CLI's OpenAI-compatible server.

## Requirements

- macOS 27+ with `/usr/bin/fm` available.
- `pi` (pi-coding-agent) installed.

## Install

```sh
pi install /path/to/pifm        # global (~/.pi/agent/settings.json)
pi install -l /path/to/pifm     # project-local (.pi/settings.json)
```

## Run

```sh
pi --provider apple-fm --model system
# or, to persist for future sessions, inside pi:
# /model apple-fm/system
```

`fm serve` is started automatically if it isn't already running on the configured port, and torn down on pi shutdown. If you already have an `fm serve` running, pifm reuses it and leaves it alone.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PIFM_PORT` | `11435` | Port for fm serve (used for both spawn and probe). |
| `PIFM_BASE_URL` | `http://127.0.0.1:$PIFM_PORT/v1` | Override the full base URL (takes precedence over `PIFM_PORT`). |
| `PIFM_FM_BIN` | `/usr/bin/fm` | Path to the `fm` binary. |
| `PIFM_LOG` | `~/.pi/agent/pifm-serve.log` | Log file for spawned fm serve stdout/stderr. |
| `PIFM_DEBUG` | unset | When set, logs any tools dropped due to schema incompatibility. |

## How it works

On extension load:

1. Probe `GET /health` on the configured port. If reachable, reuse it.
2. Otherwise spawn `fm serve --port $PIFM_PORT` as a child process, logging to `PIFM_LOG`, and wait up to 10s for it to become healthy.
3. Call `GET /v1/models` and register the result with pi under provider name `apple-fm`. If the call fails, fall back to registering `system` and `pcc` so the provider still appears in `/model`.

On `model_select`: if the user switches to any `apple-fm/*` model mid-session and fm isn't healthy, spawn it the same way.

On `session_shutdown`: kill the child *only if pifm spawned it*. An `fm serve` you started manually is untouched.

Streaming, tool calls, and the agent loop are handled by pi's built-in `openai-completions` transport.

### Tool-schema compatibility

`fm serve`'s tool-definition parser is stricter than the OpenAI reference. It rejects:

- `parameters` of type `"object"` missing `properties` or `required` (we add empty ones).
- Any **nested object** below the top-level `parameters` — including objects inside `array.items`.

The second restriction means pi's built-in `edit` tool (which takes `edits: [{oldText, newText}, ...]`) is rejected outright. Rather than fail the whole request, a `before_provider_request` hook drops any tool whose schema contains nested objects. The model still gets `read`, `bash`, and `write`, and can use `read` + `write` to perform edits.

## Status

Verified working with both `system` (on-device) and `pcc` (Private Cloud Compute) models: plain replies, `bash` tool calls, `read` tool calls. Note that `fm available --model pcc` may report PCC as unavailable on a host where `fm serve` actually accepts PCC requests — trust the serve path. **PCC only seems to work if you run `fm serve` yourself.** Not yet verified: image input, long-context behavior, multi-turn sessions.

Context windows: `system` = 4096, `pcc` = 32768. `maxTokens` defaults to 4096 for both. `fm serve`'s `/v1/models` doesn't report these, so they're hardcoded; any future model is read from `/v1/models` if it supplies `context_window` / `max_tokens`, otherwise it falls back to 8192 / 4096.
