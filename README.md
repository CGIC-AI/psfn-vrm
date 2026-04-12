# PSFN VRM

Thin-client VRM speech UI for Hermes.

## What It Is

`psfn-vrm` is a browser-first VRM shell built on `three-vrm`. It talks directly to Hermes over OpenAI-style endpoints:

- `POST /v1/chat/completions`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/speech`

The app is intentionally thin:

- full-screen VRM viewer
- minimal text chat
- STT toggle or push-to-talk
- TTS playback with mouth movement
- settings modal for Hermes URL, API key, VRM, STT/TTS, and shortcut

## Requirements

- Node.js 20+
- Hermes with the native audio API patch in this repo
- A browser secure context for microphone input

Microphone capture is the hard requirement:

- `https://...` works
- `http://localhost` works
- random plain `http://lan-host` does not reliably work for remote devices

If you want STT from phones or another desktop on the LAN, put the app behind HTTPS. Practical options:

- Nginx or Caddy with a real cert
- Tailscale HTTPS hostnames
- Cloudflare Tunnel
- Cloudflare Pages for the app plus a separate HTTPS hostname for Hermes

## Local Setup

1. Install deps:

```bash
npm install
```

2. Start the app:

```bash
npm run dev
```

3. Start Hermes with the patched API server on a reachable host.

4. Open the app, hit `Settings`, and set:

- `Hermes URL`
- `Hermes API key` if enabled on Hermes

For a local HTTPS setup, serve the UI on one HTTPS hostname and expose Hermes on another HTTPS hostname, then set the Hermes URL in the app.

## Cloudflare

This repo is set up as a static Vite app and can be hosted on Cloudflare Pages.

Use:

- build command: `npm run build`
- output directory: `dist`

Files added for static hosting and installability:

- `public/site.webmanifest`
- `public/sw.js`
- `public/_redirects`
- `public/_headers`

Target hostname:

- `psfn-vrm.cgic.ai`

For Cloudflare deployment, the safest pattern is:

- serve the app from `https://psfn-vrm.cgic.ai`
- expose Hermes on its own HTTPS hostname
- paste that Hermes URL into the app settings

If you later proxy `/v1/*` through the same origin, the app already defaults to same-origin on HTTPS hosts.

## Hermes Patch

This repo includes the modified Hermes API server file used for this thin client:

- `vendor/hermes-agent/gateway/platforms/api_server.py`

Source branch prepared for upstream PR:

- `https://github.com/axAilotl/hermes-agent/tree/feature/native-audio-api`

The patch adds:

- native `POST /v1/audio/transcriptions`
- native `POST /v1/audio/speech`
- browser CORS exposure for session/audio headers
- body-limit exemption for audio uploads

## Notes

- The default bundled avatar is in `public/vrm/`
- Large VRM files are intentionally kept local/static
- The UI is meant to stay bare-bones
