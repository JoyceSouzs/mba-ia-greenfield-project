---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-05T10:59:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T12:55:09-03:00"
  docs/phases/phase-03-videos/context.md: "2026-10-05T13:05:00-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-05T13:10:00-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video ingestion and playback foundation — object storage, background job queue, dedicated FFmpeg worker container, 10GB direct-to-storage upload via S3 multipart presigned URLs, automatic metadata/thumbnail processing, unique public slug per video, HTTP Range streaming and download — establishing the media foundation that Phases 04-07 build upon.

---

## Step Implementations

### SI-03.1 — Dependencies, Compose Infrastructure (MinIO, Redis, Worker), and Config Namespaces

**Description:** Install Phase 03 production dependencies on the API side, add the new Compose services (MinIO, bucket bootstrap, Redis, and the dedicated `video-worker` container with its own Dockerfile), and create the `storage` and `queue` config namespaces following the Phase 01 `registerAs` pattern. The worker Dockerfile installs the `ffmpeg`/`ffprobe` binaries that the processing pipeline relies on.

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.3.0`, `ioredis@^6.0.0`, `@aws-sdk/client-s3@^3.900.0`, `@aws-sdk/s3-request-presigner@^3.900.0`, `fluent-ffmpeg@^2.1.3`, `nanoid@^5.1.16` (dynamic import — see library-refs.md TD-07 note).
- Install dev dependencies: `@types/fluent-ffmpeg@^2.1.0`.
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `MINIO_ENDPOINT` (string, required), `MINIO_REGION` (string, default `'us-east-1'`), `MINIO_ACCESS_KEY` (string, required), `MINIO_SECRET_KEY` (string, required), `BUCKET_VIDEOS_RAW` (string, default `'videos-raw'`), `BUCKET_VIDEOS_PROCESSED` (string, default `'videos-processed'`), `BUCKET_THUMBNAILS` (string, default `'thumbnails'`), `PRESIGN_STREAM_TTL_SECONDS` (number, default `900`), `PRESIGN_DOWNLOAD_TTL_SECONDS` (number, default `3600`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `VIDEO_PROCESSING_QUEUE` (string, default `'video-processing'`), `VIDEO_PROCESSING_ATTEMPTS` (number, default `3`), `VIDEO_PROCESSING_BACKOFF_MS` (number, default `10000`).
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` required; others with defaults). Update `.env.example` with the full block from `library-refs.md`.
- Add `minio`, `createbuckets`, `redis`, and `video-worker` services to `nestjs-project/compose.yaml`:
  - **`minio`:** image `minio/minio:latest`, command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`, ports `9000:9000` and `9001:9001`, healthcheck `curl -f http://localhost:9000/minio/health/live`.
  - **`createbuckets`:** image `minio/mc:latest`, `depends_on: { minio: { condition: service_healthy } }`, entrypoint shell script running `mc alias set local http://minio:9000 $$MINIO_ROOT_USER $$MINIO_ROOT_PASSWORD && mc mb --ignore-existing local/videos-raw local/videos-processed local/thumbnails`, exits after bootstrap.
  - **`redis`:** image `redis:7-alpine`, port `6379:6379`, healthcheck `redis-cli ping`.
  - **`video-worker`:** build `context: .`, `dockerfile: video-worker/Dockerfile.dev` (new file; see SI-03.6), env from the same `.env`, `depends_on: { db: service_healthy, redis: service_healthy, minio: service_healthy, createbuckets: service_completed_successfully }`.
- Make `nestjs-api` depend on `redis` and `minio` healthy, and on `createbuckets` completing successfully.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/storage.config.spec.ts` | Unit | Factory reads env, applies defaults, exposes expected keys |
| `src/config/queue.config.spec.ts` | Unit | Factory reads env, applies defaults, enforces positive integers for retry/backoff |
| `src/config/env.validation.integration-spec.ts` _(extended)_ | Integration | New env keys are enforced (`MINIO_ACCESS_KEY` required → Joi error) |

**Dependencies:** None

**Acceptance criteria:**

- `docker compose up -d` starts `nestjs-api`, `db`, `mailpit`, `minio`, `redis`, `video-worker` — all reach `healthy` (or `completed` for `createbuckets`).
- `mc ls local/` from inside the `createbuckets` container (or `docker compose exec minio mc ls local`) lists the three buckets.
- `redis-cli -h redis ping` from inside the API container returns `PONG`.
- Starting the API without `MINIO_ACCESS_KEY` causes a Joi validation error at bootstrap.

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity scoped to a `Channel` (many-to-one), model the status enum and all storage/metadata columns called out in TD-07/TD-08, generate the migration, and wire the entity into a new `VideosModule`. The entity is deliberately minimal — just what is required to satisfy Phase 03 acceptance criteria; Phase 04 (video editing) adds category, visibility, and description.

**Technical actions:**

- Create `src/videos/entities/video-status.enum.ts` — exports `VideoStatus = 'draft' | 'uploading' | 'processing' | 'ready' | 'failed'` as a TypeScript string-literal union AND a PostgreSQL enum type `video_status`.
- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns:
  - `id` (uuid PK generated)
  - `channel_id` (uuid, FK → channels.id, not null, indexed)
  - `title` (varchar(200), not null)
  - `status` (enum `video_status`, not null, default `'draft'`)
  - `public_slug` (varchar(16), unique, not null — generated by `nanoid(11)`)
  - `raw_object_key` (varchar(255), not null — e.g., `<channelId>/<videoId>/raw`)
  - `multipart_upload_id` (varchar(255), nullable — set during `draft`/`uploading`, cleared on `complete` or `abort`)
  - `thumbnail_object_key` (varchar(255), nullable — set by worker on success)
  - `duration_seconds` (integer, nullable — set by worker on success)
  - `metadata` (jsonb, nullable — raw `ffprobe` output: width, height, codec, bitrate, container)
  - `failed_reason` (text, nullable — set by worker on terminal failure)
  - `created_at`, `updated_at` (`@CreateDateColumn`, `@UpdateDateColumn`)
  - Define `@ManyToOne(() => Channel, { nullable: false, onDelete: 'CASCADE' })` with `@JoinColumn({ name: 'channel_id' })`.
- Generate migration via `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL for the enum type creation, unique index on `public_slug`, and FK with `ON DELETE CASCADE` on `channel_id`.
- Create `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, exports `TypeOrmModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Insert happy path; `public_slug` unique constraint; `channel_id` FK; `ON DELETE CASCADE` from channel; default `status='draft'`; enum rejects unknown values |
| `src/database/migrations.integration-spec.ts` _(extended)_ | Integration | Migration applies and reverts cleanly; `video_status` enum type is created on apply and dropped on revert |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule.forFeature wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table and the `video_status` enum.
- Inserting a video with a duplicate `public_slug` fails with a unique constraint violation.
- Deleting a channel cascades to its videos.
- Inserting a video with `status='something-else'` fails with an enum violation.

---

### SI-03.3 — Storage Module (`src/storage/`) — AWS SDK Wrapper for MinIO

**Description:** Encapsulate all S3-compatible interactions behind a `StorageService`. Expose a narrow, typed API (multipart lifecycle + presigned GET) so controllers and the worker never import AWS SDK types directly. This is the only module that knows the SDK's shape.

**Technical actions:**

- Create `src/storage/storage.module.ts` — provides and exports `StorageService`.
- Create `src/storage/storage.service.ts` with:
  - Private `S3Client` instance built in `onModuleInit` from `storageConfig`: `{ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true }`.
  - `createMultipartUpload({ bucket, key, contentType })` → returns `{ uploadId: string }`.
  - `signUploadPartUrls({ bucket, key, uploadId, partNumbers })` → returns `Array<{ partNumber: number; url: string }>`; TTL = `PRESIGN_STREAM_TTL_SECONDS` (reused), signed via `s3-request-presigner`.
  - `completeMultipartUpload({ bucket, key, uploadId, parts })` where `parts: Array<{ partNumber: number; eTag: string }>` → returns `{ location: string }`.
  - `abortMultipartUpload({ bucket, key, uploadId })` → returns `void`.
  - `signGetObjectUrl({ bucket, key, expiresInSeconds, responseContentDisposition? })` → returns `string`.
  - `headObject({ bucket, key })` → returns `{ contentLength: number; contentType?: string }` — used by the worker to validate the upload completed.
- Export public typed DTO shapes from `src/storage/storage.types.ts` (e.g., `UploadPartUrl`, `CompletedPart`) — consumed by the videos service.
- The service is registered globally via `StorageModule` imported by `VideosModule` and (standalone) by `WorkerModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.spec.ts` | Unit | Each public method builds the correct `*Command` (SDK stubbed with `aws-sdk-client-mock`); presigned URL contains the expected method/bucket/key/expires |
| `src/storage/storage.service.integration-spec.ts` | Integration | Hits the real MinIO from Compose: creates a multipart upload for a 10MiB fixture with two 5MiB parts, signs both URLs, PUTs via `fetch`, completes the upload, HEAD confirms the object; then `signGetObjectUrl` yields a URL that returns 206 for a `Range: bytes=0-1023` request; `abortMultipartUpload` cleans up |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- All six public methods compile with strict TypeScript types; no `any` leakage from AWS SDK.
- The integration spec successfully uploads a fixture through presigned URLs end-to-end against MinIO.
- Presigned GET URL returns `206 Partial Content` with the correct `Content-Range` for a Range request.
- `abortMultipartUpload` leaves no residue (`mc ls --recursive` for the key shows nothing).

---

### SI-03.4 — Queue Module (`src/queue/`) — BullMQ Wiring and Job Contract

**Description:** Register the `video-processing` queue on the API side (producer) and expose a typed `VideoProcessingProducer` service that encapsulates job enqueueing. The worker side (consumer) is implemented in SI-03.6 — this SI defines only the contract and the producer. The queue config comes from `queueConfig`.

**Technical actions:**

- Create `src/queue/queue.module.ts` — imports `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.redisHost, port: cfg.redisPort, maxRetriesPerRequest: null } }) })` and `BullModule.registerQueueAsync({ name: cfg.videoProcessingQueue, useFactory: … })`; exports both.
- Create `src/queue/video-processing.job.ts` — exports:
  - `VIDEO_PROCESSING_JOB` constant = `'video.process'` (BullMQ job name).
  - `VideoProcessingJobData` type = `{ videoId: string; channelId: string; rawObjectKey: string }`.
  - `VideoProcessingJobResult` type = `{ durationSeconds: number; thumbnailObjectKey: string; metadata: Record<string, unknown> }`.
- Create `src/queue/video-processing.producer.ts` — class `VideoProcessingProducer` injected with `@InjectQueue(cfg.videoProcessingQueue)`, exposes `enqueue(data: VideoProcessingJobData): Promise<string>` returning the BullMQ job id. Options: `attempts = cfg.videoProcessingAttempts`, `backoff = { type: 'exponential', delay: cfg.videoProcessingBackoffMs }`, `removeOnComplete = 100`, `removeOnFail = 1000`.
- Export `VideoProcessingProducer` from `QueueModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-processing.producer.spec.ts` | Unit | `enqueue` calls `queue.add` with the correct job name, payload, and options derived from config |
| `src/queue/video-processing.producer.integration-spec.ts` | Integration | Enqueues against the real Redis from Compose; a scoped `Worker` created in the test picks up the job and sees the same payload; job id round-trips |
| `src/queue/queue.module.spec.ts` | Unit | Module compiles; the queue name resolves from config |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Enqueuing a job stores a BullMQ record in Redis with the configured retry/backoff options.
- A separate `Worker` wired to the same queue name receives the job data unchanged.
- Omitting any field of `VideoProcessingJobData` is a TypeScript compile error.

---

### SI-03.5 — Videos API: Upload Lifecycle (`POST /channels/:channelId/videos`, parts, complete, abort)

**Description:** Expose the four endpoints that drive the client-side multipart upload: create (returns `videoId` + `uploadId` + object key), request a batch of signed part URLs, complete the upload (triggers enqueue), and abort. All endpoints are owner-scoped (JWT required; channel must belong to the caller). The `public_slug` is generated at creation time with a unique-constraint-aware retry loop.

**Technical actions:**

- Create DTOs in `src/videos/dto/`:
  - `create-video.dto.ts` → `{ title: string }` (`@IsString`, `@Length(1, 200)`); also `{ contentType?: string }` optional (defaults to `application/octet-stream`).
  - `request-part-urls.dto.ts` → `{ partNumbers: number[] }` (`@ArrayNotEmpty`, each `@IsInt @Min(1) @Max(10000)`).
  - `complete-upload.dto.ts` → `{ parts: Array<{ partNumber: number; eTag: string }> }` (nested DTO with `@ValidateNested({ each: true })`).
- Create `src/videos/videos.repository.ts` — thin wrapper around `Repository<Video>` with:
  - `createDraft({ channelId, title, rawObjectKey, uploadId }): Promise<Video>` — generates a `public_slug` via `nanoid(11)` and retries up to 3 times on unique-constraint violation.
  - `findByIdOwnedBy(videoId, channelId)` / `findBySlug(slug)` / `markUploading(id)` / `markProcessing(id)` / `markReady(id, { durationSeconds, thumbnailObjectKey, metadata })` / `markFailed(id, reason)` / `clearMultipart(id)`.
- Create `src/videos/videos.service.ts`:
  - `createVideo({ channelId, title, contentType }): Promise<{ videoId; publicSlug; uploadId; rawObjectKey }>` — generates `videoId` (uuid), builds `rawObjectKey = ${channelId}/${videoId}/raw`, calls `storage.createMultipartUpload`, persists row in `draft`.
  - `requestPartUrls({ videoId, channelId, partNumbers }): Promise<UploadPartUrl[]>` — loads video (owner-scoped), asserts `status in ('draft', 'uploading')`, transitions `draft → uploading` on first call via `markUploading`, calls `storage.signUploadPartUrls`.
  - `completeUpload({ videoId, channelId, parts }): Promise<void>` — loads video, asserts `status === 'uploading'`, calls `storage.completeMultipartUpload`, transitions row to `processing` + `clearMultipart`, calls `producer.enqueue({ videoId, channelId, rawObjectKey })`.
  - `abortUpload({ videoId, channelId }): Promise<void>` — asserts status in `('draft', 'uploading')`, calls `storage.abortMultipartUpload`, deletes the row (or marks `failed` with reason `'aborted'` — decision below in Error Catalog).
- Create domain exceptions in `src/videos/exceptions/`: `VideoNotFoundException`, `NotChannelOwnerException`, `InvalidStatusTransitionException`, `UploadAlreadyCompletedException`. Extend `DomainException`; map to codes in the Error Catalog.
- Create `src/videos/videos.controller.ts`:
  - `POST /channels/:channelId/videos` → `createVideo` (201).
  - `POST /videos/:videoId/parts` → `requestPartUrls` (200).
  - `POST /videos/:videoId/complete` → `completeUpload` (204).
  - `DELETE /videos/:videoId/upload` → `abortUpload` (204).
  - All four require JWT (no `@Public()`); each loads the video, verifies the authenticated user owns the channel.
- Add Swagger decorators (`@ApiTags('videos')`, `@ApiOperation`, `@ApiResponse` with the error envelope).

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | Each service method on happy path and each failure path (unknown video, foreign channel, wrong status) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Full lifecycle against real DB + MinIO + Redis: create → part URLs → PUT a 10 MiB fixture via `fetch` to the URLs → complete → row shows `processing` AND a job is in Redis with the expected payload |
| `test/videos-upload.e2e-spec.ts` | E2E | HTTP flow with JWT; owner-scope enforcement (401/403 for foreign channels); abort cleans the multipart; validation errors shape |
| `src/videos/exceptions/*.spec.ts` | Unit | Each new domain exception maps to the correct code + status in the filter |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Creating a video via the API persists a row with `status='draft'`, a 11-char `public_slug`, and a non-null `multipart_upload_id`.
- Requesting part URLs transitions the row to `uploading` on first call; URLs are usable from `curl` for direct PUT.
- Completing with the collected ETags finalizes the upload in MinIO and enqueues a BullMQ job.
- Aborting removes the multipart record from MinIO and the DB row (or marks it `failed` with reason `'aborted'`).
- A caller who does not own the channel receives `403 NOT_CHANNEL_OWNER`.

---

### SI-03.6 — Video Worker (`nestjs-project/video-worker/`) — Processing Pipeline

**Description:** Build a dedicated worker that consumes `video.process` jobs, streams the raw object from MinIO to the local `tmpfs`, runs `ffprobe` to extract duration/metadata, extracts a thumbnail at the midpoint via `ffmpeg`, uploads the thumbnail to the `thumbnails` bucket, and updates the `videos` row to `ready`. Terminal failures (BullMQ `attempts` exhausted) flip the row to `failed` with `failed_reason`.

**Technical actions:**

- Create `nestjs-project/video-worker/Dockerfile.dev`:
  - Base `node:22-slim`.
  - `RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*`.
  - `WORKDIR /home/node/app`.
  - Mount the project source as a volume (same pattern as `nestjs-api`); install deps on first boot or via multi-stage.
  - `CMD ["node", "--loader", "ts-node/esm", "video-worker/src/main.ts"]` _or_ a `dist/`-based command depending on the hot-reload path chosen (`ts-node` is acceptable in dev).
- Create `video-worker/src/worker.module.ts` — standalone Nest module importing `ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig, storageConfig, queueConfig], validationSchema })`, `TypeOrmModule.forRootAsync(...)` (same options as the API), `StorageModule`, `QueueModule`, and declaring the `VideoProcessor` provider.
- Create `video-worker/src/video.processor.ts` — a BullMQ `WorkerHost` registered via `@Processor(cfg.videoProcessingQueue)`:
  - `process(job: Job<VideoProcessingJobData, VideoProcessingJobResult>)` body:
    1. Load video by `job.data.videoId`; abort with a non-retryable error if `status !== 'processing'` (idempotency).
    2. Build `tmpInput = /tmp/<videoId>/raw` and `tmpThumb = /tmp/<videoId>/thumb.jpg`. `mkdir -p`.
    3. `headObject` on `videos-raw` to validate the upload exists and is non-zero.
    4. Download via a signed GET URL (reusing `storage.signGetObjectUrl`) + `fetch` with streaming write to `tmpInput`.
    5. `ffprobe` via `fluent-ffmpeg.ffprobe(tmpInput)` → extract `format.duration`, `streams[0].width/height/codec_name/bit_rate`, container (`format.format_name`). Assemble `metadata` object.
    6. `fluent-ffmpeg(tmpInput).screenshots({ timestamps: ['50%'], filename: 'thumb.jpg', folder: tmpdir, size: '640x?' })` → single JPEG.
    7. Upload `tmpThumb` to `thumbnails` bucket under key `${channelId}/${videoId}/thumb.jpg` via a single-part PUT (not multipart — thumbnails are tiny).
    8. Call `videosRepository.markReady(videoId, { durationSeconds, thumbnailObjectKey, metadata })`.
    9. Remove `/tmp/<videoId>/` in a `finally`.
  - On exception thrown from the processor, BullMQ handles retries automatically. On `failed` event with `attempts` exhausted, a listener registered on the `Worker` calls `videosRepository.markFailed(videoId, failedReason)`. Use `job.opts.attempts` and `job.attemptsMade` to detect the terminal attempt inside the processor as well, defensively.
- Create `video-worker/src/main.ts`:
  ```typescript
  async function bootstrap() {
    const app = await NestFactory.createApplicationContext(WorkerModule);
    app.enableShutdownHooks();
    // The Worker starts automatically because @Processor is a provider.
    Logger.log(`Video worker started`, 'Bootstrap');
  }
  bootstrap();
  ```
- Register the `video-worker` service in `compose.yaml` (added in SI-03.1) with the dockerfile above.
- Add `src/videos/videos.repository.ts` methods consumed by the worker (`markReady`, `markFailed`) — already outlined in SI-03.5; wire the worker's import.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `video-worker/src/video.processor.spec.ts` | Unit | `process` happy path with mocked storage/ffprobe/ffmpeg returns the correct result object; a failing `ffprobe` propagates (BullMQ retries); the `failed` listener calls `markFailed` after `attempts` exhausted |
| `video-worker/src/video.processor.integration-spec.ts` | Integration | End-to-end: upload a sample MP4 fixture to `videos-raw` via `StorageService`, enqueue a job, wait for completion, assert DB row flips to `ready`, assert thumbnail bytes exist in `thumbnails` bucket, assert `duration_seconds` is within 1s of the fixture's known duration |
| `video-worker/src/worker.module.spec.ts` | Unit | Standalone module compiles with the expected providers |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `docker compose up video-worker` logs `Video worker started` and connects to Redis.
- Submitting a job via the producer causes the worker to update the DB row to `ready` within a few seconds (for a <10MB fixture) and leaves a JPEG at the configured thumbnail key.
- A deliberately corrupted MP4 (truncated file) causes the worker to retry 3 times with exponential backoff and finally mark the row `failed` with a human-readable `failed_reason`.
- `/tmp/<videoId>/` is removed after both success and failure.

---

### SI-03.7 — Playback and Download Endpoints (`GET /videos/:slug`, `/stream`, `/download`)

**Description:** Three endpoints keyed by the public `nanoid` slug. `GET /videos/:slug` returns metadata (public — any viewer); `/stream` and `/download` issue a 307 redirect to a MinIO presigned GET URL (streaming TTL 15 min, download TTL 1h, with `Content-Disposition: attachment` baked into the signed URL for downloads). Non-`ready` videos are only accessible to the owning channel; strangers receive 404 to avoid status enumeration.

**Technical actions:**

- Create `src/videos/videos-playback.controller.ts` (or extend `videos.controller.ts`):
  - `GET /videos/:slug` — `@Public()`, returns `{ slug, title, status, durationSeconds, thumbnailUrl }` for `ready` videos; for other statuses, 404 unless the caller is authenticated AND owns the channel (resolve by loading `channel.user_id` and comparing to `req.user.id`). `thumbnailUrl` is a presigned GET URL with the stream TTL.
  - `GET /videos/:slug/stream` — `@Public()`, loads the video, enforces the same visibility rules, calls `storage.signGetObjectUrl({ bucket: BUCKET_VIDEOS_RAW, key: raw_object_key, expiresInSeconds: PRESIGN_STREAM_TTL_SECONDS })`, responds with `res.redirect(307, url)`.
  - `GET /videos/:slug/download` — `@Public()`, same rules, calls `signGetObjectUrl({ ..., expiresInSeconds: PRESIGN_DOWNLOAD_TTL_SECONDS, responseContentDisposition: 'attachment; filename="<title>.<ext>"' })` and 307-redirects. Filename extension is inferred from `metadata.format_name` or defaults to `.mp4`.
- Expose a `videos.view.service.ts` orchestrating authorization + URL minting; keeps the controller thin.
- Add Swagger decorators documenting the 307 behavior and the error envelope.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.view.service.spec.ts` | Unit | Visibility logic: `ready` → anyone; `draft/processing/failed` → owner only (via mocked repository); unknown slug → 404 |
| `test/videos-playback.e2e-spec.ts` | E2E | `GET /videos/:slug/stream` responds 307 with a `Location: http://minio:9000/...` URL; following the URL with `Range: bytes=0-1023` returns `206 Partial Content` with the correct `Content-Range`; `GET /videos/:slug/download` embeds `response-content-disposition=attachment` in the query string |

**Dependencies:** SI-03.5, SI-03.6 (needs `ready` videos to exist end-to-end for the Range test)

**Acceptance criteria:**

- An anonymous `GET /videos/:slug` for a `ready` video returns 200 with the metadata envelope including a working `thumbnailUrl`.
- An anonymous `GET /videos/:slug/stream` responds 307; following it to MinIO with `Range: bytes=0-N` returns `206 Partial Content`.
- An anonymous `GET /videos/:slug/download` responds 307 to a URL that MinIO answers with `Content-Disposition: attachment; filename="…"`.
- `GET /videos/:slug` for a `processing` or `failed` video returns 404 for an anonymous caller and 200 (with `status` field) for the channel owner.

---

### SI-03.8 — Observability, OpenAPI Export, and Documentation

**Description:** Close the phase with the operational and documentation deliverables required by the DoD: structured logs on worker job lifecycle, OpenAPI export refreshed, and the `CLAUDE.md` files updated with the videos section (module, endpoints, queue/worker, storage) in a way that is coherent with the real code shipped.

**Technical actions:**

- Add structured `Logger` calls in `VideoProcessingProducer` (job enqueued), `video.processor.ts` (job received, step completed, duration), and `VideosService` (status transitions). Use the Nest `Logger` with context strings.
- Add a BullMQ `events` listener in `WorkerModule` that logs `completed` and `failed` with job id, attempts, and duration.
- Run `npm run openapi:export` to refresh `nestjs-project/openapi.json` with the new endpoints and schemas.
- Update `nestjs-project/CLAUDE.md`: new section **"Videos module (Fase 03)"** covering module structure, endpoints, status machine, Compose services, worker, storage buckets, and the "no mocks for Compose infra" testing rule.
- Update root `CLAUDE.md`: add a Fase 03 bullet to the "Architecture (C4 Container Diagram)" section listing the materialized containers (Redis, MinIO, Video Worker), and add a brief "Videos" entry to the Repository Structure block.
- Update `nestjs-project/README.md` (if present): environment variables and docker services list.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` _(extended)_ | Integration | OpenAPI generation now exports all `/videos`, `/channels/:id/videos` endpoints with error envelopes; schemas for request DTOs and response envelopes are present |

**Dependencies:** SI-03.5, SI-03.6, SI-03.7

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run openapi:export` finishes without errors and `openapi.json` is updated with the Fase 03 paths.
- `nestjs-project/CLAUDE.md` has a "Videos module (Fase 03)" section; filenames and endpoints match what is actually in `src/videos/` and the Compose file.
- Root `CLAUDE.md` references the three new containers (`minio`, `redis`, `video-worker`) in the Architecture section.
- A sample run of the full flow produces log lines tagged with video id and job attempt count.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| channel_id | uuid | FK → channels.id, not null, on delete cascade, indexed | Owning channel |
| title | varchar(200) | not null | Set at creation; editable in Fase 04 |
| status | enum `video_status` | not null, default `'draft'` | `draft` \| `uploading` \| `processing` \| `ready` \| `failed` |
| public_slug | varchar(16) | unique, not null | 11-char `nanoid` (TD-07) |
| raw_object_key | varchar(255) | not null | `<channelId>/<videoId>/raw` in `videos-raw` |
| multipart_upload_id | varchar(255) | nullable | Set during `draft`/`uploading`, cleared on complete/abort |
| thumbnail_object_key | varchar(255) | nullable | Set by worker on `ready` |
| duration_seconds | integer | nullable | Set by worker on `ready` |
| metadata | jsonb | nullable | Raw ffprobe output subset |
| failed_reason | text | nullable | Set by worker on terminal failure |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | |

**Relations:** Video → Channel (many-to-one, cascade delete from channel)
**Indexes:** `(public_slug)` — unique, `(channel_id)` — FK/listing

**Enum type:** `video_status` with values `('draft', 'uploading', 'processing', 'ready', 'failed')`.

---

### API Contracts

#### POST /channels/:channelId/videos (SI-03.5)

**Auth:** Bearer access token; caller must own the channel.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer <access_token>

**Request body:**
- title: string, required — 1 to 200 chars
- contentType: string, optional — default `application/octet-stream`

**Response 201:**
- videoId: string (uuid)
- publicSlug: string (11 chars)
- uploadId: string
- rawObjectKey: string
- bucket: string — `videos-raw`

**Error responses:**
- 403 NOT_CHANNEL_OWNER
- 404 CHANNEL_NOT_FOUND
- 400 VALIDATION_ERROR
- 401 — missing/invalid access token

---

#### POST /videos/:videoId/parts (SI-03.5)

**Auth:** Bearer access token; caller must own the channel owning the video.

**Request body:**
- partNumbers: number[], required — each between 1 and 10000, at most 1000 per request

**Response 200:**
- parts: Array<{ partNumber: number; url: string; expiresAt: string (ISO) }>

**Error responses:**
- 403 NOT_CHANNEL_OWNER
- 404 VIDEO_NOT_FOUND
- 409 INVALID_STATUS_TRANSITION — if status is not `draft` or `uploading`
- 400 VALIDATION_ERROR

---

#### POST /videos/:videoId/complete (SI-03.5)

**Auth:** Bearer access token; caller must own the channel.

**Request body:**
- parts: Array<{ partNumber: number; eTag: string }>, required — min 1

**Response 204:** No content.

**Error responses:**
- 403 NOT_CHANNEL_OWNER
- 404 VIDEO_NOT_FOUND
- 409 UPLOAD_ALREADY_COMPLETED — if status is not `uploading`
- 400 VALIDATION_ERROR

---

#### DELETE /videos/:videoId/upload (SI-03.5)

**Auth:** Bearer access token; caller must own the channel.

**Response 204:** No content.

**Error responses:**
- 403 NOT_CHANNEL_OWNER
- 404 VIDEO_NOT_FOUND
- 409 INVALID_STATUS_TRANSITION — if status is `processing`, `ready`, or `failed`

---

#### GET /videos/:slug (SI-03.7)

**Auth:** Public. Owner-only visibility applies to non-`ready` statuses.

**Response 200:**
- slug: string
- title: string
- status: `'ready' | 'processing' | 'failed'` _(exposed to owner; anonymous only sees `ready`)_
- durationSeconds: number | null
- thumbnailUrl: string | null — presigned GET URL (TTL 15 min)

**Error responses:**
- 404 VIDEO_NOT_FOUND — unknown slug OR non-`ready` video requested anonymously
- 401 — if a stale/invalid access token is sent

---

#### GET /videos/:slug/stream (SI-03.7)

**Auth:** Public. Owner-only visibility applies to non-`ready` statuses.

**Response 307:** `Location:` presigned GET URL on MinIO (TTL 15 min). The client (or `<video>` tag) performs the actual bytes transfer against MinIO, which answers `206 Partial Content` to `Range` requests.

**Error responses:**
- 404 VIDEO_NOT_FOUND or VIDEO_NOT_READY

---

#### GET /videos/:slug/download (SI-03.7)

**Auth:** Public. Owner-only visibility applies to non-`ready` statuses.

**Response 307:** `Location:` presigned GET URL on MinIO (TTL 1 h) with `response-content-disposition=attachment; filename="<slug>.<ext>"` embedded.

**Error responses:**
- 404 VIDEO_NOT_FOUND or VIDEO_NOT_READY

---

#### Validation Rules — Video DTOs

| Field | Rule | Error message |
|-------|------|---------------|
| title | 1 to 200 chars | title must be longer than or equal to 1 character / shorter than or equal to 200 |
| partNumbers | non-empty array; each 1 ≤ n ≤ 10000 | partNumbers must not be empty / each value must be between 1 and 10000 |
| parts[].partNumber | 1 ≤ n ≤ 10000 | partNumber must be between 1 and 10000 |
| parts[].eTag | non-empty string | eTag must be a string |

---

### Authorization Matrix

| Endpoint | Public | Authenticated (any) | Authenticated (channel owner) | Notes |
|----------|--------|---------------------|-------------------------------|-------|
| POST /channels/:channelId/videos | | | ✓ | Caller must own the channel |
| POST /videos/:videoId/parts | | | ✓ | Caller must own the video's channel |
| POST /videos/:videoId/complete | | | ✓ | |
| DELETE /videos/:videoId/upload | | | ✓ | |
| GET /videos/:slug | ✓ | ✓ | ✓ | Non-`ready` statuses hidden from anonymous; owner sees any status |
| GET /videos/:slug/stream | ✓ | ✓ | ✓ | Same visibility rules; 307 redirect to signed URL |
| GET /videos/:slug/download | ✓ | ✓ | ✓ | Same visibility rules; 307 redirect with `attachment` disposition |

---

### Error Catalog

**Error response format:** inherited from Fase 02 — `{ statusCode: number, error: string, message: string }` with `error` carrying the domain code.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found | POST /channels/:channelId/videos with unknown channelId |
| NOT_CHANNEL_OWNER | 403 | You do not own this channel | Any owner-scoped video endpoint when `req.user.id !== channel.user_id` |
| VIDEO_NOT_FOUND | 404 | Video not found | Any route resolving a video by id/slug that does not exist (also returned on non-`ready` anonymous access to hide status) |
| VIDEO_NOT_READY | 404 | Video not ready | Stream/download for a non-`ready` video from an anonymous caller or a non-owner |
| INVALID_STATUS_TRANSITION | 409 | Invalid status transition | Requesting part URLs or abort on a video whose status does not permit the operation |
| UPLOAD_ALREADY_COMPLETED | 409 | Upload already completed | POST /videos/:videoId/complete when status is not `uploading` |
| VIDEO_PROCESSING_FAILED | — | _(not an HTTP error; persisted in `videos.failed_reason`)_ | Terminal processing failure after BullMQ retries exhausted |

---

### Events / Messages

**Queue:** `video-processing` (configurable via `VIDEO_PROCESSING_QUEUE`, default `'video-processing'`).

#### Job `video.process`

**Direction:** API (producer) → `video-worker` (consumer).

**Payload (`VideoProcessingJobData`):**
```typescript
{
  videoId: string;      // uuid of the Video row
  channelId: string;    // uuid of the owning Channel (for logging/metrics; redundant with videoId)
  rawObjectKey: string; // key inside the videos-raw bucket (<channelId>/<videoId>/raw)
}
```

**Options:**
- `attempts`: `VIDEO_PROCESSING_ATTEMPTS` (default 3)
- `backoff`: `{ type: 'exponential', delay: VIDEO_PROCESSING_BACKOFF_MS }` (default 10 s)
- `removeOnComplete`: 100
- `removeOnFail`: 1000

**Result (`VideoProcessingJobResult`), emitted on successful completion:**
```typescript
{
  durationSeconds: number;
  thumbnailObjectKey: string;  // key inside the thumbnails bucket
  metadata: {
    width?: number;
    height?: number;
    codecName?: string;
    bitRate?: number;
    container?: string;        // e.g., "mov,mp4,m4a,3gp,3g2,mj2"
  };
}
```

**Side effects on success:** Video row transitions `processing → ready`; `duration_seconds`, `metadata`, `thumbnail_object_key` populated; `multipart_upload_id` already null.

**Side effects on terminal failure (attempts exhausted):** Video row transitions `processing → failed`; `failed_reason` populated with the stringified last error.

**Idempotency:** The worker refuses to process a job whose video row is not in `processing`. This handles duplicate deliveries and manual re-enqueues without data corruption.

---

### Status Machine

```
                     ┌─────────────────────────────┐
                     ▼                             │
POST /channels/:id/videos                          │
      │                                            │
      ▼                                            │
    draft ───── POST /videos/:id/parts ─────► uploading
      │                                            │
      │ DELETE /videos/:id/upload                  │ DELETE /videos/:id/upload
      ▼                                            ▼
    (row removed)                              (row removed)
                                                   │
                                                   │ POST /videos/:id/complete
                                                   ▼
                                               processing
                                                   │
                        worker success             │  worker terminal failure
                        ◄────────────────┐  ┌──────┤
                        │                │  │      │
                        ▼                │  │      ▼
                      ready              │  │   failed
                                         └──┘
```

- `draft`, `uploading` → removed by `DELETE /videos/:id/upload`.
- `processing`, `ready`, `failed` → cannot be aborted via API in Fase 03 (deferred; `failed` recovery is non-recoverable this phase per TD-08).

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.4

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5
    └── SI-03.6
        └── SI-03.7
            └── SI-03.8
```

Linearized implementation order: **SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8.**

SI-03.6 depends on SI-03.5 only to the extent that SI-03.5 wires the `markReady`/`markFailed` repository methods used by the worker. The worker code itself does not depend on the controller/service layer added in SI-03.5; implementation order may interleave freely within the Dependency Map above.

---

## Deliverables

- [ ] `videos` table with the full column set and `video_status` enum, migration applies and reverts cleanly.
- [ ] `MinIO` service in Compose with three buckets bootstrapped (`videos-raw`, `videos-processed`, `thumbnails`) via a `createbuckets` one-shot init.
- [ ] `Redis` service in Compose, reachable from both `nestjs-api` and `video-worker`.
- [ ] `video-worker` service in Compose with its own Dockerfile (base `node:22-slim` + `ffmpeg`/`ffprobe`), connects to Redis and processes jobs end-to-end.
- [ ] Upload of a 10GB-class file via S3 multipart presigned URLs; no bytes pass through the NestJS API process.
- [ ] Pre-registration of the video as a `draft` row on `POST /channels/:channelId/videos`.
- [ ] Status machine `draft → uploading → processing → ready | failed` enforced in service transitions and reflected in the DB.
- [ ] Automatic metadata extraction (duration + width/height/codec/bitrate/container) persisted on `ready`.
- [ ] Automatic thumbnail extracted at the midpoint and stored in the `thumbnails` bucket, keyed on `thumbnail_object_key`.
- [ ] Unique `nanoid` public slug per video, enforced by a DB unique index.
- [ ] `GET /videos/:slug/stream` 307-redirects to a presigned GET URL that answers `206 Partial Content` to `Range` requests from MinIO.
- [ ] `GET /videos/:slug/download` 307-redirects to a presigned GET URL with `Content-Disposition: attachment`.
- [ ] JWT-protected owner-scoped endpoints for the entire upload lifecycle; public endpoints for metadata/stream/download of `ready` videos.
- [ ] New domain exceptions and error codes integrated with the `DomainExceptionFilter` and the `ApiErrorEnvelope` DTO.
- [ ] Unit, integration (against real MinIO/Redis/Postgres), and E2E (via supertest) tests green.
- [ ] `openapi.json` refreshed via `npm run openapi:export` with the Fase 03 endpoints.
- [ ] `nestjs-project/CLAUDE.md` has a "Videos module (Fase 03)" section coherent with the shipped code.
- [ ] Root `CLAUDE.md` lists the three new containers (`minio`, `redis`, `video-worker`) in the Architecture section.
- [ ] Full test suite passes (`docker compose exec nestjs-api npm test -- --runInBand`, `npm run test:integration`, `npm run test:e2e`).
- [ ] `docker compose exec nestjs-api npx tsc --noEmit` exits with code 0.
- [ ] `docker compose exec nestjs-api npm run lint` passes.
- [ ] Work committed to `feature/phase-03-videos`; PR opened against `dev` (never `main`).
