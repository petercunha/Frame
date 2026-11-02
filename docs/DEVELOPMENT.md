# Working on Frame

Frame is a local-first Node.js and TypeScript app. Express serves the API; React and Vite provide the interface. It uses OpenRouter’s asynchronous Video API rather than running a model locally.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies. Use `npm ci` for an exact lockfile install. |
| `npm run dev` | Start the server with Vite and automatic reload. |
| `npm run typecheck` | Check the client, server, shared types, and tests. |
| `npm test` | Run integration tests against a mocked OpenRouter service. No credits or real key needed. |
| `npm run build` | Type-check and build both the client and Node server. |
| `npm start` | Serve the production build. Run the build command first. |

Use Node.js 22.12 or newer. `.nvmrc` selects Node 24 for users of nvm. Run commands from the repository root.

## Optional configuration

Copy `.env.example` to `.env` and set only what you need:

```dotenv
OPENROUTER_API_KEY=your-key-here
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
```

- **OPENROUTER_API_KEY** is optional. If set, it provides a server-wide default key. A connected browser session can temporarily override it. The `.env` file is ignored by Git.
- **PORT** changes the local port.
- **HOST** defaults to loopback so the server is reachable only from this computer.
- **DATA_DIR** controls where uploads and history are stored. Keep it on persistent storage if you run a long-lived server.

Keys entered through the interface live only in server memory. They expire after 24 hours without use; active polling counts as use. A server restart clears those session keys. An environment key remains available from the environment.

This app provides browser-session workspace isolation, not a full account or authentication system. Before exposing it to other people or the public internet, add authenticated access, HTTPS, appropriate rate and storage limits, and a production storage strategy. Do not expose a shared environment key to unauthenticated visitors. The JSON store is intended for one Node process.

## Project map

```text
client/             React studio, styles, API helper, and accessible dialogs
server/app.ts       Express API, uploads, sessions, polling, and media streaming
server/generation.ts Request validation and reference payload construction
server/openrouter.ts OpenRouter client and model metadata parsing
server/store.ts     Serialized, atomic JSON persistence
server/index.ts     Development and production server entry point
server/app.test.ts  Integration and validation tests
shared/types.ts     Shared data types and conservative cost estimates
public/             App icon
docs/screenshots/   Real browser screenshots used in the README
data/               Runtime files; created automatically and ignored by Git
```

## Generation flow

1. Read the live catalog from `GET /api/v1/videos/models` (cached for five minutes).
2. Validate the requested settings against the selected model’s capabilities.
3. Read selected local assets and encode them as data URLs. Frame images use `frame_images`; image, audio, and video references use `input_references` with the documented type for each asset.
4. Submit one request to `POST /api/v1/videos`. Submission is never automatically retried, avoiding accidental duplicate charges.
5. Save the job ID and settings locally; poll every five seconds with exponential backoff for transient failures.
6. Stop on `completed`, `failed`, `cancelled`, or `expired`. Keep terminal errors, output count, and reported USD cost in history.
7. Proxy the authenticated content endpoint for playback and downloads. Range headers and partial responses are forwarded, and API keys stay out of media URLs.

Only the OpenRouter base URL is used for authenticated requests. Polling URLs and content URLs from upstream responses are not followed directly. Job tracking resumes when the workspace is reopened after a server restart and a key is available.

The client supports duration, resolution, aspect ratio, exact size, seed, generated audio, upscaling controls, and allowlisted provider options where advertised. Provider options use the documented `{ "options": { "provider-slug": { ... } } }` structure. Reference input support still depends on the provider; an advertised output capability does not promise support for every input type.

Estimated prices are calculated only for recognized per-second output SKUs. Token-priced or ambiguous models show their raw pricing under Advanced settings and their actual cost when reported by OpenRouter.

## Local API

All paths below start with `/api`. Browser session cookies are HttpOnly and SameSite Strict. Cross-origin writes are rejected.

| Path | Methods | Purpose |
| --- | --- | --- |
| `/health` | GET | Server health |
| `/connection` | GET, POST, DELETE | Inspect, validate, or remove a session key |
| `/models` | GET | Live model catalog |
| `/assets` | GET, POST | List assets or upload multipart `files` |
| `/assets/:id` | DELETE | Delete an owned asset |
| `/assets/:id/content` | GET | Read an owned asset |
| `/jobs` | GET, POST | List or submit owned generations |
| `/jobs/:id` | DELETE | Remove a terminal generation from local history |
| `/jobs/:id/content` | GET | Stream an output; `index=N` selects a clip, `download=1` downloads it |

Uploads are checked by file signatures, not just the provided filename. Limits are 12 files per upload, 25 MB per file, 50 MB of references per job, and three active jobs per browser workspace. Frame slots are unique; mixing frame images with reference assets is rejected because OpenRouter gives frames precedence. There is no cancellation button because the documented API does not expose a cancellation endpoint.

Local data and keys are excluded from the initial Git repository. Back up `data/` if you want to retain uploads and job history. Generated media is streamed from OpenRouter rather than archived automatically on disk.

## Verification

The integration suite covers key validation, upload signature checks and session isolation, model discovery, asynchronous state transitions, provider failures, retry behavior, reference serialization, request validation, cost units, and ranged video downloads. Browser checks also cover desktop/mobile layout, model search, uploads, and playback against a local mock service with a playable MP4. A paid live generation requires your own key and is not part of automated tests.

## API references

- [OpenRouter video generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Video model discovery](https://openrouter.ai/api/v1/videos/models)
- [Canonical OpenAPI schema](https://openrouter.ai/openapi.json) — includes the image, audio, and video reference union.
- [Wan 3.0 model documentation](https://openrouter.ai/alibaba/wan-3.0/llms.txt)

The catalog and API schema were checked during implementation. Models, rates, and provider-specific restrictions can change; the running application discovers current options rather than hardcoding the model list.
