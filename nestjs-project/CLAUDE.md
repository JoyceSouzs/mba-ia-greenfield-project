# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

The API build must keep `src/` as the TypeScript root so `dist/` mirrors `src/` (`dist/main.js`, `dist/mail/templates/`). `tsconfig.build.json` therefore excludes `video-worker/` (the worker runs via `ts-node` and is never built). If any directory outside `src/` gets compiled, `tsc` moves the output to `dist/src/...` while assets stay at `dist/mail/...` — templates are then not found at runtime and `start:prod` (`node dist/main`) breaks.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Fase 03)

Backend for video upload, processing, and playback. Lives under `src/videos/` with sibling `src/storage/` and `src/queue/`, plus a dedicated `video-worker/` process. Decisions in `docs/phases/phase-03-videos/phase-03-videos.md` and `docs/decisions/technical-decisions-phase-03-videos.md`.

### Infra services (Compose)

- **`minio`** (`cleanstart/minio:latest`): S3-compatible object storage. API `9000`, console `9001`. `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` from env. Data lives on an in-memory tmpfs (dev-only; data is ephemeral).
- **`createbuckets`** (`pgsty/mc:latest`): one-shot init that creates the three buckets (`videos-raw`, `videos-processed`, `thumbnails`) and exits. Depends on `minio` healthy.
- **`redis`** (`redis:7-alpine`): BullMQ backend. Port `6379`.
- **`video-worker`** (custom image, `node:25.6.0-slim` + `ffmpeg`/`ffprobe`): dedicated container that consumes the `video-processing` queue. Shares the project source via volume mount, like `nestjs-api`. Default command keeps the container alive; start the worker explicitly with `docker compose exec video-worker npx ts-node video-worker/src/main.ts`.

### Modules

- `src/videos/`: entities (Video + status enum), DTOs, domain exceptions, two controllers (`VideosController` for upload lifecycle, `VideosPlaybackController` for public playback/download), two services (`VideosService` for write ops, `VideoViewService` for read + visibility), a `VideoProcessingModule` (only `VideoProcessingService` + `forFeature([Video])`) that is the worker's sole dependency on the videos domain, and a `slug.generator.ts` using `nanoid@^3.3.20` (CJS — see `docs/phases/phase-03-videos/library-refs.md` TD-07).
- `src/storage/`: `StorageService` is the only module that imports from `@aws-sdk/*`. Exposes a narrow typed API (`createMultipartUpload`, `signUploadPartUrls`, `completeMultipartUpload`, `abortMultipartUpload`, `signGetObjectUrl`, `headObject`, `putObject`).
- `src/queue/`: `BullModule` wiring + `VideoProcessingProducer` (producer side only; the worker side is in `video-worker/`).
- `video-worker/src/`: `WorkerModule` is a Nest standalone application loading ConfigModule (database/storage/queue configs only), TypeORM (explicit `entities: [Video, Channel, User]` — Video's relation graph), StorageModule, QueueModule and `VideoProcessingModule`, plus the `VideoProcessor` provider. It must **not** import `VideosModule`: that pulls `AuthModule` → `MailModule`, whose `MAILER_OPTIONS` needs `mailConfig`, which the worker does not load. `worker.module.integration-spec.ts` compiles the real `WorkerModule` to catch this. `main.ts` bootstraps `NestFactory.createApplicationContext`.

### Status machine

`draft → uploading → processing → ready | failed`

- `draft`: created by `POST /channels/:channelId/videos` (multipart initiated, nothing uploaded yet).
- `uploading`: first `POST /videos/:videoId/parts` flips the status.
- `processing`: `POST /videos/:videoId/complete` finalizes multipart and enqueues `video.process`.
- `ready` / `failed`: set by the worker. Terminal failure after `VIDEO_PROCESSING_ATTEMPTS` (default 3) with exponential backoff (default 10s).
- `DELETE /videos/:videoId/upload` deletes the DB row entirely (only valid from `draft`/`uploading`).

### Endpoints

Owner-scoped (require JWT; caller must own the channel):

- `POST /channels/:channelId/videos` → 201 `{ videoId, publicSlug, uploadId, rawObjectKey, bucket }`
- `POST /videos/:videoId/parts` → 200 `{ parts: Array<{ partNumber, url, expiresAt }> }`
- `POST /videos/:videoId/complete` → 204
- `DELETE /videos/:videoId/upload` → 204

Public (owner-only visibility for non-`ready`):

- `GET /videos/:slug` → 200 `{ slug, title, status, durationSeconds, thumbnailUrl }`
- `GET /videos/:slug/stream` → 307 redirect to presigned GET on MinIO (15 min TTL). The client's follow-up request honours HTTP Range and receives `206 Partial Content` directly from MinIO.
- `GET /videos/:slug/download` → 307 redirect to presigned GET with `response-content-disposition=attachment; filename="…"` (1 h TTL).

### Error catalog additions

| Code | HTTP | Trigger |
|------|------|---------|
| CHANNEL_NOT_FOUND | 404 | Unknown channel on `POST /channels/:channelId/videos` |
| NOT_CHANNEL_OWNER | 403 | Owner-scoped endpoint called by a non-owner |
| VIDEO_NOT_FOUND | 404 | Unknown slug/id (also returned to anonymous callers for non-`ready` videos to hide status existence) |
| VIDEO_NOT_READY | 404 | Stream/download for a non-`ready` video |
| INVALID_STATUS_TRANSITION | 409 | Requesting parts or aborting a video whose status does not permit the operation |
| UPLOAD_ALREADY_COMPLETED | 409 | `POST /videos/:videoId/complete` when status is not `uploading` |
| SLUG_GENERATION_FAILED | 500 | nanoid collided after 5 insert-retries (astronomically unlikely) |

### Events / Messages

Queue `video-processing` carries one job name: `video.process` with payload `{ videoId, channelId, rawObjectKey }`. BullMQ options: `attempts: 3`, `backoff: exponential 10s`, `removeOnComplete: 100`, `removeOnFail: 1000`. The worker is idempotent on duplicate deliveries (refuses to process jobs whose row is not `processing`).

### Testing

- Unit specs for every service, DTO validation path, and SDK/BullMQ interaction (SDK mocked via `aws-sdk-client-mock`; `fluent-ffmpeg` mocked in the processor unit).
- Integration specs against the real Compose infrastructure (PostgreSQL, MinIO, Redis). The worker's integration spec requires the real `ffmpeg`/`ffprobe` binaries and therefore must run inside `docker compose exec video-worker` — the API container intentionally lacks ffmpeg.
- E2E specs via supertest for the owner-scoped upload lifecycle and the public playback/download endpoints (including follow-up of the 307 redirect to assert `206 Partial Content` and `Content-Disposition: attachment` from MinIO).
- BullMQ keeps a Redis connection open after the suite; test commands that boot a BullMQ queue should pass `--forceExit`.
