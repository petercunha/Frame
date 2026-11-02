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

Video/audio editing and the media integration tests require `ffmpeg` (with H.264/AAC encoding support) and `ffprobe` on PATH. On macOS, `brew install ffmpeg` supplies both. Image preparation uses Sharp, installed with the Node dependencies. Missing media tools produce an actionable editor error; original uploads and image editing remain available.

## Optional configuration

Copy `.env.example` to `.env` and set only what you need:

```dotenv
OPENROUTER_API_KEY=your-key-here
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
MAX_UPLOAD_MB=10240
```

- **OPENROUTER_API_KEY** is optional. If set, it provides a server-wide default key. A connected browser session can temporarily override it. The `.env` file is ignored by Git.
- **PORT** changes the local port.
- **HOST** defaults to loopback so the server is reachable only from this computer.
- **DATA_DIR** controls where uploads and history are stored. Keep it on persistent storage if you run a long-lived server.
- **MAX_UPLOAD_MB** sets the per-original upload limit in MB (default 10240, or 10 GB). This is independent of the 25 MB per-input and 50 MB per-generation limits. Originals stream to disk, with browser upload progress.
- **FFMPEG_PATH / FFPROBE_PATH** optionally select executable paths when the tools are not on PATH. Commands are spawned using argument arrays, never a shell.

Keys entered through the interface live only in server memory. They expire after 24 hours without use; active polling counts as use. A server restart clears those session keys. An environment key remains available from the environment.

This app provides browser-session workspace isolation, not a full account or authentication system. Before exposing it to other people or the public internet, add authenticated access, HTTPS, appropriate rate and storage limits, and a production storage strategy. Do not expose a shared environment key to unauthenticated visitors. The JSON store is intended for one Node process.

## Project map

```text
client/             React studio, styles, API helper, and accessible dialogs
server/app.ts       Express API, uploads, sessions, polling, and media streaming
server/generation.ts Request validation and reference payload construction
server/openrouter.ts OpenRouter client and model metadata parsing
server/store.ts     Serialized, atomic JSON persistence
server/media.ts     Media inspection, edit validation, and queued Sharp/FFmpeg preparation
server/media.test.ts Real media processing and original-preservation tests
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
3. Resolve each selected asset to an immutable prepared version, or its original if unedited, and validate input size before reading it into memory. Encode those bytes as data URLs. Frame images use `frame_images`; image, audio, and video references use `input_references` with the documented type for each asset.
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
| `/config` | GET | Public upload-size limit |
| `/connection` | GET, POST, DELETE | Inspect, validate, or remove a session key |
| `/models` | GET | Live model catalog |
| `/assets` | GET, POST | List assets or upload multipart `files` |
| `/assets/:id` | DELETE | Delete an owned asset |
| `/assets/:id/content` | GET | Read an owned asset |
| `/assets/:id/editor` | GET | Inspect original dimensions, orientation, and duration; read preparation state |
| `/assets/:id/prepare` | POST | Validate edits and enqueue a separate prepared input |
| `/assets/:id/prepared` | DELETE | Restore original input without deleting saved versions |
| `/assets/:id/prepared/:versionId/content` | GET | Stream an owned prepared version, with range support |
| `/jobs` | GET, POST | List or submit owned generations |
| `/jobs/:id` | DELETE | Remove a terminal generation from local history |
| `/jobs/:id/content` | GET | Stream an output; `index=N` selects a clip, `download=1` downloads it |

Uploads are checked by file signatures, not just the provided filename. Limits are 12 originals per upload, a configurable 10 GB per original, 25 MB per model input, 50 MB of references per job, and three active generations per browser workspace. The Node server allows long upload requests; production reverse proxies also need suitable body-size and timeout settings. Frame slots are unique; mixing frame images with reference assets is rejected because OpenRouter gives frames precedence. There is no cancellation button because the documented API does not expose a cancellation endpoint.

## Non-destructive asset preparation

`data/uploads/` contains unchanged originals. `data/prepared/` contains separate, versioned model inputs. Metadata and edit recipes are stored with the asset in `studio.json`. Private filenames and version lists never appear in public API responses.

The editor uses normalized display-coordinate crops, maximum width/height bounds, trim start/end seconds, and an optional video mute setting. EXIF image orientation and video display rotation are respected. Images export as PNG, video as H.264/AAC MP4 with even pixel dimensions, and audio as PCM WAV. Resize bounds never enlarge the original. The first frame of animated images is used for prepared stills.

Preparation runs asynchronously with at most two tasks in parallel. Assets expose queued/processing/completed/failed state and progress. Failed or interrupted preparation leaves the original and last successful input untouched. Reopening the workspace after a restart marks interrupted tasks as failed so they can be retried.

Generation requests capture a prepared version ID before submitting to OpenRouter. Re-editing an asset cannot change the bytes already selected for a submitted generation. Earlier prepared versions are retained until the original asset is deleted. Deleting an original removes its prepared versions too; deleting or restoring while preparation is running is rejected.

Use `POST /assets/:id/prepare` with a JSON recipe such as:

```json
{
  "crop": { "x": 0.25, "y": 0, "width": 0.5, "height": 1 },
  "maxWidth": 1280,
  "maxHeight": 1280,
  "start": 120,
  "end": 125,
  "mute": false
}
```

Omit crop and size controls for audio, and time controls for images. Limits and media duration are validated server-side. FFmpeg inputs allow local file/pipe protocols only; file paths and filter expressions are generated on the server, not accepted from clients. Outputs larger than 25 MB fail with a request to shorten the selection or reduce dimensions. A task has a ten-minute processing timeout; seeking before decoding makes short excerpts of long recordings efficient.

Local data and keys are excluded from the initial Git repository. Back up `data/` if you want to retain uploads and job history. Generated media is streamed from OpenRouter rather than archived automatically on disk.

## Verification

The integration suite covers key validation, upload signature checks and session isolation, model discovery, asynchronous state transitions, provider failures, retry behavior, reference serialization, request validation, cost units, and ranged video downloads. Real media fixtures verify cropping location, resizing, trimming, audio removal, EXIF/video orientation, prepared version stability, restart recovery, failed preparations, large-original upload handling, and byte-for-byte original preservation. Browser checks cover desktop/mobile editors, draggable crops, time selection, and prepared image/video/audio playback. A paid live generation requires your own key and is not part of automated tests.

## API references

- [OpenRouter video generation guide](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Video model discovery](https://openrouter.ai/api/v1/videos/models)
- [Canonical OpenAPI schema](https://openrouter.ai/openapi.json) — includes the image, audio, and video reference union.
- [Wan 3.0 model documentation](https://openrouter.ai/alibaba/wan-3.0/llms.txt)

The catalog and API schema were checked during implementation. Models, rates, and provider-specific restrictions can change; the running application discovers current options rather than hardcoding the model list.
