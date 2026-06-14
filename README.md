# pifm

A [pi-coding-agent](https://pi.dev) provider extension that routes pi to **Apple Foundation Models** via the `fm` CLI's OpenAI-compatible server.

## Requirements

- macOS 27+ with `/usr/bin/fm` available.
- `pi` (pi-coding-agent) installed.

## Run

In one terminal, start the fm server:

```sh
fm serve --port 11435
```

In another terminal, point pi at this extension and pick a model:

```sh
cd /path/to/pifm
pi -e ./index.ts
# inside pi:
# /model apple-fm/system
```

To install permanently into your user scope:

```sh
pi install /path/to/pifm
```

(Use `-l` for project-local install.)

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PIFM_BASE_URL` | `http://127.0.0.1:11435/v1` | Where `fm serve` is listening. |

## How it works

The extension calls `fm serve`'s `GET /v1/models` at startup to discover available models and registers them with pi under provider name `apple-fm`. If the server isn't reachable at load time, the extension falls back to registering `system` and `pcc` so the provider still appears in `/model`.

Streaming, tool calls, and the agent loop are handled by pi's built-in `openai-completions` transport — no custom streaming code lives here.
