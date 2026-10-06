# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/8 completed

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

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._

---

## SI-03.6 — Video Worker — Processing Pipeline

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._

---

## SI-03.7 — Playback and Download Endpoints

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._

---

## SI-03.8 — Observability, OpenAPI Export, and Documentation

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._
