# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

---

## SI-03.1 — Dependencies, Compose Infrastructure (MinIO, Redis, Worker), and Config Namespaces

**Status:** completed

**Tests:**
- `src/config/storage.config.spec.ts` — 3 tests, all passing
- `src/config/queue.config.spec.ts` — 3 tests, all passing
- `src/config/env.validation.integration-spec.ts` — extended with 7 new tests for Phase 03 storage/queue vars; all 11 tests in the file passing

**Observations:**
- Installed deps: `@nestjs/bullmq@^12`, `bullmq@^6.3`, `ioredis@^5.11.1` (pinned to 5.x — `typeorm@0.3.28` declares `peerOptional ioredis@^5`; BullMQ 6 supports both lines, so `^5` satisfies both), `@aws-sdk/client-s3@^3.1146`, `@aws-sdk/s3-request-presigner@^3.1146`, `fluent-ffmpeg@^2.1.3`, `nanoid@^5.1.16`, `@types/fluent-ffmpeg@^2.1.28` (dev).
- Image substitutions: `minio/minio` and `minio/mc` were removed from Docker Hub (both return `pull access denied`, `quay.io/minio/minio` is behind auth). Switched to `cleanstart/minio:latest` (hardened community rebuild, uid 65532) and `pgsty/mc:latest` (community fork of mc) — documented in `library-refs.md`. Updated `library-refs.md` accordingly.
- `cleanstart/minio` runs as uid 65532 and the auto-created named volume was owned by root → `file access denied`. Switched to `tmpfs: /data` with `uid=65532,gid=65532`. Data is ephemeral in dev (acceptable for this phase; production path uses S3 and does not care).
- Pre-existing lint debt in `src/` and `test/` (150 errors + 40 warnings, all `no-unsafe-*` / `unbound-method` in test files from Phases 01/02) is **not** addressed in this SI per user decision — scope is Phase 03. New files added here (storage/queue config and specs, env.validation extension) all pass `eslint` cleanly. The DoD lint gate will need to be revisited at phase close.
- `createbuckets` ran successfully — all three buckets (`videos-raw`, `videos-processed`, `thumbnails`) created on MinIO.
- `docker compose ps` shows: `db healthy`, `mailpit healthy`, `minio healthy`, `redis healthy`, `createbuckets Exited (0)`, `nestjs-api Up`, `video-worker Up`.

---

## SI-03.2 — Video Entity and Migration

**Status:** completed

**Tests:**
- `src/videos/entities/video.entity.integration-spec.ts` — 8 tests covering default status, unique public_slug, FK rejection, cascade delete from channel, invalid enum rejection, jsonb metadata, nullable fields, and ManyToOne channel loading.
- `src/videos/videos.module.spec.ts` — 1 test confirming module compiles with TypeOrmModule.forFeature([Video]).
- `src/database/migrations.integration-spec.ts` — extended to 3 tests: applies 3 migrations (users+channels, auth tokens, videos), creates the `video_status` enum, reverts the last migration dropping both the videos table and the enum.
- 12/12 green.

**Observations:**
- `TypeORM migration:generate` auto-created `src/database/migrations/1791230441896-CreateVideos.ts` with correct SQL (enum type, table, index on channel_id, FK ON DELETE CASCADE). Prettier auto-fix normalized its formatting.
- Database pre-conditions: the test DB had leftover state from Phase 02 migrations without a `migrations` row; manually re-registered the two prior migrations via `INSERT INTO migrations` before running `migration:run` for the first time. This is a one-off dev-env fix, not something the fase needs to carry.
- Added `videos` to `cleanAllTables` and extended `createTestDataSource` to use a typed `EntityCtor` instead of the lint-flagged `Function` type. Both fixes are strictly additive — no behavior change in existing specs.
- `AppModule` now loads `storageConfig` and `queueConfig` (missing in SI-03.1 — fixed here) and imports `VideosModule`.
- Flakiness: when the migrations spec runs concurrently with the entity spec and both operate on the same DB, synchronize+drops can race. Current `--runInBand` + prefixed cleanup is sufficient; running `src/videos/` and `src/database/migrations.integration-spec.ts` together passes consistently.

---

## SI-03.3 — Storage Module (`src/storage/`) — AWS SDK Wrapper for MinIO

**Status:** completed

**Tests:**
- `src/storage/storage.service.spec.ts` — 13 unit tests with `aws-sdk-client-mock`: `createMultipartUpload` (happy path, missing UploadId error, default contentType), `signUploadPartUrls` (one URL per partNumber, encodes partNumber+uploadId), `completeMultipartUpload` (parts mapping to {ETag,PartNumber}), `abortMultipartUpload`, `signGetObjectUrl` (TTL + response-content-disposition), `headObject` (contentLength+contentType, defaults), `putObject`, `onModuleDestroy`.
- `src/storage/storage.service.integration-spec.ts` — 4 integration tests against the real MinIO service: full multipart upload end-to-end (6MiB + 1KiB parts, complete, head verifies size), signed GET URL returning 206 Partial Content for a Range request, aborted multipart cleanly fails to complete, put+head round-trip for a thumbnail.
- 17/17 green.

**Observations:**
- Installed dev dep `aws-sdk-client-mock@^4` for unit tests (keeps the SDK untouched while asserting command inputs/outputs).
- The 10MiB payload in the Range test is reused as the single-part multipart (above 5MiB minimum per S3 spec).
- `fetch` body typing: Node's fetch rejects a `Buffer` directly (not in `BodyInit`); converted with `new Uint8Array(buf)` at the boundary. Documented in-line for the next SI.
- Integration tests use `BUCKET_VIDEOS_RAW` from env (defaults to `videos-raw`) and `BUCKET_THUMBNAILS` likewise, so they align with Compose bootstrap.
- Validates TD-06 one SI early: the 206 Partial Content from a presigned GET URL + Range header is now proven to work against real MinIO.

---

## SI-03.4 — Queue Module (`src/queue/`) — BullMQ Wiring and Job Contract

**Status:** completed

**Tests:**
- `src/queue/video-processing.producer.spec.ts` — 2 unit tests covering the `queue.add` call (name + payload + options from config) and the "missing job id" error branch.
- `src/queue/video-processing.producer.integration-spec.ts` — 1 integration test against the real Redis: enqueues a job via the producer, a scoped BullMQ `Worker` on the same queue consumes it, asserts the id round-trips and the options (attempts, backoff) survive serialization.
- `src/queue/queue.module.spec.ts` — 1 test confirming `QueueModule` compiles, both `VideoProcessingProducer` and the queue token resolve.
- 4/4 green.

**Observations:**
- Added `transformIgnorePatterns: ['node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)']` to the Jest config in `package.json` because `@nestjs/bullmq@^12` is published as ESM-only (`"type": "module"`) and ts-jest otherwise fails to parse its `export` statement. All other project tests still pass with this scope.
- Peer-dep sanity: `@nestjs/bullmq@12` peers on `@nestjs/common@^10 || ^11 || ^12` and `bullmq@^3..^6` — our pins (Nest 11, BullMQ 6.3) are inside both ranges.
- `VIDEO_PROCESSING_QUEUE_NAME` constant isolates the string that both `BullModule.registerQueue` and `@InjectQueue()` must share (decorators cannot read from config at compile time); the configurable name in `queueConfig.videoProcessingQueue` remains the source of truth for env-driven changes and is already asserted in `queue.config.spec.ts`.
- `AppModule` now imports `QueueModule`.
- Jest warns "did not exit one second after the test run has completed" — a known BullMQ open-handle on the queue connection; not failing. Will revisit at the SI-03.8 observability pass if it becomes noisy.

---

## SI-03.5 — Videos API: Upload Lifecycle

**Status:** completed

**Tests:**
- `src/videos/videos.service.spec.ts` — 13 unit tests covering: `createVideo` (happy path + ChannelNotFound + NotChannelOwner + slug retry on unique violation), `requestPartUrls` (draft→uploading transition + skip when already uploading + VideoNotFound + NotChannelOwner + invalid status), `completeUpload` (success + rejects when status ≠ uploading), `abortUpload` (success + rejects when status ∈ processing/ready/failed).
- `src/videos/videos.service.integration-spec.ts` — 2 end-to-end integration tests against real DB + MinIO + Redis: happy path (create → requestPartUrls → PUT 6MiB+tail to MinIO → complete → DB status=processing + job in Redis queue with correct payload) and abort path (create → abort → row removed).
- `test/videos-upload.e2e-spec.ts` — 7 e2e via supertest: create as owner (201), as foreign user (403 NOT_CHANNEL_OWNER), missing title (400 VALIDATION_ERROR), requestPartUrls (owner 200, stranger 403), abort (204 then subsequent parts 404), premature complete (409 UPLOAD_ALREADY_COMPLETED), unauthenticated (401).
- 22/22 new tests green across the SI.

**Observations:**
- **nanoid pinned to `^3.3.20`** (CJS). Tried `nanoid@^5.1.16` ESM with `const { nanoid } = await import('nanoid');` inside the slug generator — ts-jest raises `A dynamic import callback was invoked without --experimental-vm-modules`, which would require flipping the entire test runner into ESM mode. Not worth the blast radius for a single import. Updated `library-refs.md` TD-07 note accordingly.
- Added `transformIgnorePatterns` for `@nestjs/bullmq` to **both** jest configs (`package.json` and `test/jest-e2e.json`) — ESM-only package needs ts-jest to transform it.
- Service surface: `createVideo`, `requestPartUrls`, `completeUpload`, `abortUpload`. All owner-scoped: `loadOwnedVideo` resolves the channel relation and throws `NotChannelOwnerException` when `channel.user_id !== req.user.id`.
- Public slug uniqueness: insert-retry loop with PG error code `23505` + `detail` containing `public_slug` (same pattern as `channels.service.ts` nickname). 5 attempts cap; throws `SlugGenerationFailedException` if all collide (practically impossible at 64^11 entropy).
- Status transitions: `draft → uploading` on first `POST /videos/:id/parts`; `uploading → processing` on `POST /videos/:id/complete`; abort deletes the DB row entirely (TD-08: aborted videos leave no trace per plan). `processing → ready|failed` is the worker's responsibility — SI-03.6.
- Error catalog: `CHANNEL_NOT_FOUND (404)`, `NOT_CHANNEL_OWNER (403)`, `VIDEO_NOT_FOUND (404)`, `INVALID_STATUS_TRANSITION (409)`, `UPLOAD_ALREADY_COMPLETED (409)`, `SLUG_GENERATION_FAILED (500)`.
- DTOs follow the project convention: class-validator decorators + Swagger annotations. `CompleteUploadDto` uses `@ValidateNested` + `@Type` for the parts array.
- Controller: 4 endpoints, all with `@ApiBearerAuth()` + `@ApiOperation` + `@ApiResponse` per status. Uses `ParseUUIDPipe` for `channelId` and `videoId` params.

---

## SI-03.6 — Video Worker — Processing Pipeline

**Status:** completed

**Tests:**
- `src/videos/video-processing.service.spec.ts` — 4 unit tests: `getStatus` (hit + miss), `markReady` (parameterized SQL with jsonb cast on `metadata`, avoids SQL injection), `markFailed`.
- `video-worker/src/video.processor.spec.ts` — 4 unit tests (fluent-ffmpeg mocked): happy path (headObject → signed GET → fetch → ffprobe → thumbnail → putObject → markReady), status-not-processing idempotent skip, intermediate failure (throws but does not markFailed), terminal failure (markFailed with reason).
- `video-worker/src/worker.module.spec.ts` — 1 test confirming module composition.
- `video-worker/src/video.processor.integration-spec.ts` — 2 end-to-end integration tests against real MinIO + real DB + real ffmpeg: happy path (3s MP4 fixture → status=ready, duration≈3s, metadata {width:320,height:240,codecName:'h264'}, thumbnail bytes in MinIO with content-type image/jpeg), terminal failure (missing raw → status=failed with reason). Must run in the `video-worker` container (has ffmpeg; the API container does not).
- 11/11 green (9 unit + 2 integration).

**Observations:**
- `VideoProcessingService` in `src/videos/`: shared between the API side (for future use) and the worker. Provides `getStatus`, `markReady`, `markFailed`. `markReady` uses raw parameterized SQL (`$1..$4`) with `::jsonb` cast because `Repository.update` cannot typecheck the jsonb column against `Record<string, unknown>`.
- `VideoProcessor` extends `WorkerHost` (@nestjs/bullmq) and consumes `VIDEO_PROCESSING_QUEUE_NAME`. On each attempt: `headObject` → `signGetObjectUrl` → `fetch` → `writeFile` → `ffprobe` → thumbnail extraction via `fluent-ffmpeg.screenshots({ timestamps: ['50%'], size: '640x?' })` → `putObject` to `thumbnails` bucket → `markReady`. On failure: logs attempt vs total, calls `markFailed` only on the terminal attempt (`job.attemptsMade + 1 >= job.opts.attempts`). `finally` block cleans the tmpfs dir with error swallow allowed per `nestjs-services.md` (background-task cleanup, not request path).
- `WorkerModule` is a Nest standalone application (`NestFactory.createApplicationContext`). It loads the same `ConfigModule`, `TypeOrmModule.forRootAsync` and infrastructure modules as the API — only the HTTP controllers are absent. `main.ts` boots the context; the BullMQ `Worker` starts automatically because `@Processor` is a provider.
- **Jest config:** added `rootDir: '.'` + `roots: ['<rootDir>/src', '<rootDir>/video-worker']` to pick up specs in both trees. Integration run must happen inside `docker compose exec video-worker` because the API container intentionally lacks ffmpeg (TD-04: isolation is the whole point).
- Dockerfile.dev of the worker already installs ffmpeg (SI-03.1); the integration test exercised the real binary end-to-end.
- Fixture: `test/fixtures/sample.mp4` — 3-second 320×240 H.264 clip generated once via `ffmpeg -f lavfi -i testsrc=duration=3:size=320x240:rate=10 -c:v libx264 -shortest`. Committed as a static asset.
- `--forceExit` is needed in all jest runs that boot BullMQ (the connection leaves open handles). Not a correctness issue; cleanup detail.

---

## SI-03.7 — Playback and Download Endpoints

**Status:** completed

**Tests:**
- `src/videos/video-view.service.spec.ts` — 9 unit tests covering visibility rules (ready → anyone; non-ready → owner only; stranger gets 404 to hide status), signed URL emission for metadata/stream/download, Content-Disposition sanitization + extension picking, VideoNotReadyException branches.
- `test/videos-playback.e2e-spec.ts` — 5 e2e tests: metadata happy path (anonymous), unknown slug → 404, **stream 307 → follows redirect to MinIO → `Range: bytes=0-1023` → `206 Partial Content` with `Content-Range` matching** (acceptance criterion fulfilled), download 307 with `response-content-disposition=attachment` + follow confirms `Content-Disposition: attachment; filename="…mp4"`, stream for unknown slug → 404 `VIDEO_NOT_FOUND`.
- 14/14 green.

**Observations:**
- New `VideoViewService` co-locates visibility (anonymous vs. owner), signed URL minting, and `Content-Disposition` composition. Keeps `VideosService` focused on write operations and the playback controller thin.
- New `VideosPlaybackController` (3 endpoints, all `@Public()`): `GET /videos/:slug` metadata; `GET /videos/:slug/stream` → 307 redirect to presigned GET (15 min TTL, raw bucket); `GET /videos/:slug/download` → 307 redirect to presigned GET (1 h TTL, raw bucket) with `response-content-disposition=attachment; filename="<title>.<ext>"` baked in — filename sanitization strips quotes/newlines and truncates at 100 chars.
- "Owner visibility while endpoint is `@Public()`" was the tricky bit. The global `JwtAuthGuard` short-circuits at `@Public()` and never populates `req.user`. New `tryExtractUserId` util reads the Authorization header lazily and verifies the Bearer with `JwtService.verifyAsync` — returns the `sub` on success, `null` on absence or failure. Caller passes it to the view service as the "callerUserId" for the ownership check.
- Non-ready videos are hidden from strangers with `VIDEO_NOT_FOUND` (not `VIDEO_NOT_READY`) — avoids leaking status existence to probers.
- `VideosModule` imports `AuthModule` to get `JwtModule.registerAsync` exported by auth.module.ts.
- The e2e test validates **TD-06 end-to-end**: client calls our API `/stream` → gets 307 → follows to MinIO → `Range` header → MinIO answers `206 Partial Content`. This is the full "streaming without download" acceptance criterion from the Fase 03 brief.

---

## SI-03.8 — Observability, OpenAPI Export, and Documentation

**Status:** completed

**Tests:**
- Full backend sweep (`src/queue/ src/videos/ src/storage/ src/config/`): 15 suites, 79 tests green.
- Full e2e sweep: 5 suites, 64 tests green (incl. app health, auth lifecycle, swagger, videos upload, videos playback).
- `npx tsc --noEmit`: exit 0.
- `openapi.json` re-exported with 7 new Fase 03 paths (`/channels/{channelId}/videos`, `/videos/{videoId}/parts`, `/videos/{videoId}/complete`, `/videos/{videoId}/upload`, `/videos/{slug}`, `/videos/{slug}/stream`, `/videos/{slug}/download`).

**Observations:**
- Structured `Logger` calls added in `VideoProcessingProducer` (enqueue event), `VideosService` (createVideo + completeUpload + abortUpload transitions), and `VideoProcessor` (already in place from SI-03.6: attempt log, success log, retry warning, terminal error).
- `nestjs-project/CLAUDE.md`: new "Videos Module (Fase 03)" section covering Compose services, module map, status machine, endpoints, error catalog additions, events/messages schema, and testing notes (worker integration must run inside `video-worker` container because the API image lacks ffmpeg).
- Root `CLAUDE.md`: Repository Structure now lists the new modules; Architecture section replaces the "TBD" message queue with the real stack (MinIO, Redis + BullMQ, Video Worker image).
- Fixed cross-run isolation on `video-processing.producer.integration-spec.ts` via `queue.obliterate({ force: true })` in `beforeAll`/`beforeEach`/`afterAll` — prior runs could leave orphan jobs in Redis that polluted the "first job id" assertion.
- Updated `videos.module.spec.ts` to boot the full `AppModule` (previously it tried to compile the standalone module without `AuthModule` dep).

## Review fix — Video Worker failed to boot (`MAILER_OPTIONS`)

**Status:** completed

**Problem (review comment):** upload reached MinIO and `complete` enqueued the job, but the worker never started: `WorkerModule` imported `VideosModule` → `AuthModule` → `MailModule`, and since the worker does not load `mailConfig`, Nest failed to resolve `MAILER_OPTIONS`. Videos stayed in `processing` forever. The SI-03.6 `worker.module.spec.ts` did not catch it because it assembled its own module list instead of compiling the real `WorkerModule`.

**Fix:**
- New `src/videos/video-processing.module.ts` (`forFeature([Video])` + `VideoProcessingService`) — the worker's only dependency on the videos domain. `VideosModule` no longer registers `VideoProcessingService` (the API never used it).
- `WorkerModule` imports `VideoProcessingModule` instead of `VideosModule`. Supersedes the SI-03.6 note that the worker "loads the same modules as the API".
- `WorkerModule` TypeORM config uses explicit `entities: [Video, Channel, User]` instead of `autoLoadEntities` — with only `forFeature([Video])` loaded, TypeORM failed with `Entity metadata for Video#channel was not found` (second latent bug surfaced by the real compilation test).

**Tests:**
- `worker.module.spec.ts` → `worker.module.integration-spec.ts` (it connects to Postgres/Redis): compiles the real `WorkerModule` and resolves `VideoProcessor`, `VideoProcessingService`, `StorageService`. Verified that it fails against the previous `WorkerModule` with the exact `MAILER_OPTIONS` error.
- `videos.module.spec.ts` no longer expects `VideoProcessingService` inside `AppModule`.

**Manual end-to-end validation:** worker started with `docker compose exec video-worker npx ts-node video-worker/src/main.ts` (`Video worker started`); real flow create → parts → presigned PUT to MinIO → `complete` (204) → status `ready` in ~2s with `duration_seconds=5` and `thumbnail_object_key=…/thumb.jpg`; `GET /videos/:slug` returns `thumbnailUrl`, which serves `image/jpeg` (200).

## Phase Closeout

### Full suite results

- `docker compose exec nestjs-api npm test -- --runInBand --forceExit`: **222 passed, 2 skipped** (`video-worker/src/video.processor.integration-spec.ts` auto-skips when the host container has no `ffmpeg` binary — guarded by `describeIfFfmpeg`). 38/39 suites green; the skipped one runs green inside `video-worker`.
- `docker compose exec video-worker sh -c 'cd /home/node/app && npx jest --runInBand --forceExit video-worker/src/'`: **7 passed** (the 2 ffmpeg-gated tests included).
- `docker compose exec nestjs-api npm run test:e2e -- --runInBand --forceExit`: **64 passed** (5 suites: app health, auth, swagger, videos upload, videos playback).
- `docker compose exec nestjs-api npx tsc --noEmit`: **exit 0**.

### Known debt

- `docker compose exec nestjs-api npm run lint`: 147 errors + 40 warnings — **all from Phase 01/02 files** (specs with `jest.fn()`-based mocks triggering `no-unsafe-*` and `unbound-method`, pre-existing `any` cast in `channels.service.ts`). No file introduced by Phase 03 contributes a lint error. Fixing those is out of scope per the user decision at Phase 03 kickoff; it should be addressed as a dedicated "lint-debt-sweep" task.
- ~~**Mail templates missing in `dist`**~~ — **resolved:** `tsconfig.build.json` now excludes `video-worker/` (the worker runs via `ts-node`, never built), so `tsc` keeps `src/` as root and `dist/` mirrors it again (`dist/main.js`, `dist/mail/templates/*.hbs`). Including the worker had moved output to `dist/src/...` while assets stayed in `dist/mail/`, breaking `POST /auth/register` and `start:prod`. The crash itself comes from `@nestjs-modules/mailer`'s `HandlebarsAdapter`, which throws synchronously (`readFileSync`) inside a nodemailer plugin callback — outside the awaited promise, so `MailService` cannot catch it. Verified: register → 201, email in Mailpit, API stays up.
- **`test:e2e` script lacks `--runInBand`:** `nestjs-project/CLAUDE.md` says it is "already configured", but `package.json` runs `jest --config ./test/jest-e2e.json` only; without the flag, 10 e2e tests fail from shared-DB contention. Pass `--runInBand` explicitly until fixed.

### Branch & PR

- Work was done on `feature/phase-03-videos` (created from `dev` which was created from `main`). 13 commits (5 planning artifacts + 8 implementation SIs). Ready to open PR against `dev`.
