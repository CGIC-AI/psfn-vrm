# Hermes API Notes

This frontend expects Hermes to expose OpenAI-style endpoints for text, STT, and TTS.

Required endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/audio/transcriptions`
- `POST /v1/audio/speech`

The exact patched file bundled here is:

- `vendor/hermes-agent/gateway/platforms/api_server.py`

Branch containing the isolated Hermes patch:

- `axAilotl/hermes-agent:feature/native-audio-api`

Why the patch exists:

- keeps STT/TTS inside Hermes instead of duplicating provider logic in the client
- makes the VRM app a thin web shell
- gives browser-safe headers for session continuity and audio metadata
