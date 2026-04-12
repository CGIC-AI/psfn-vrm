# PSFN VRM Design

## Summary

`psfn-vrm` is a thin web client for Hermes.

It does not run its own backend logic. The browser talks directly to Hermes over OpenAI-style endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/speech`

## Goals

- web-only VRM speech UI
- self-hostable
- desktop and mobile friendly
- minimal setup
- thin client, not a second agent runtime

## Architecture

```text
Browser app
  -> Hermes API server
     -> chat
     -> STT
     -> TTS
     -> session continuity
```

Frontend responsibilities:

- VRM rendering
- chat UI
- mic capture
- audio playback
- mouth movement
- local settings

Hermes responsibilities:

- model execution
- tool execution
- STT/TTS provider selection
- session continuity
- auth
- CORS

## Hosting

The app is built as a static Vite site and can be deployed to:

- Cloudflare Pages
- any HTTPS static host
- local reverse proxies such as Nginx or Caddy

Microphone input requires a secure context:

- `https://...`
- or `http://localhost`

## Hermes Patch

The repo vendors the modified Hermes API file used by this client:

- `vendor/hermes-agent/gateway/platforms/api_server.py`

That patch adds native audio endpoints so the browser can stay thin.
