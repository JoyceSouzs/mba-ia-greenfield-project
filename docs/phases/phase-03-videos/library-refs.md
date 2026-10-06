---
kind: phase
name: phase-03-videos
status: pinned
date: 2026-10-05
---

# phase-03-videos — Library References

Libraries newly adopted by Phase 03 and their official docs / caveats. Versions below are the latest published on npm at `date` above. The `plan-build` and `implement` stages must honor the "installed version" rule from the project `CLAUDE.md` — when installation happens, `package.json` will pin the exact minor; this file is updated if a divergence occurs.

> **Note on `context7` MCP:** the project `CLAUDE.md` requires fetching library docs via `context7`, but the `context7` MCP server is not configured in `.mcp.json` for this repository (only `postgres` is). Versions and shape below were fetched from the official npm registry (`https://registry.npmjs.org`), which is the authoritative source for the installed version. Links point to each library's canonical documentation.

---

## TD-01 — Message queue (BullMQ + Redis)

### `@nestjs/bullmq`

- **Latest:** `12.0.0`
- **Pin:** `^12.0.0` (NestJS 11 compatible per the package's peerDependencies on `@nestjs/common@^10 || ^11`)
- **Role:** NestJS integration for BullMQ. Provides `BullModule.forRoot(...)` and `BullModule.registerQueue({ name })` for the API side, and `@Processor(name)` / `WorkerHost` for the worker side.
- **Docs:** https://docs.nestjs.com/techniques/queues (NestJS Queues chapter; it specifically covers BullMQ via `@nestjs/bullmq`).

### `bullmq`

- **Latest:** `6.3.11`
- **Pin:** `^6.3.0`
- **Role:** The queue implementation itself. `Queue` for producing, `Worker` for consuming, exponential backoff + `attempts`, delayed jobs, job events.
- **Docs:** https://docs.bullmq.io/

### `ioredis`

- **Latest:** `6.0.0`
- **Pin:** `^5.11.1` (installed version: `5.11.1`).
- **Peer-dep constraint:** `typeorm@0.3.28` declares `peerOptional ioredis@^5.0.4`. Installing `ioredis@^6` fails `npm install` with `ERESOLVE`. BullMQ 6 is compatible with both ioredis 5 and 6, so pinning to `^5` is the correct resolution — it satisfies both TypeORM and BullMQ without `--legacy-peer-deps` hacks.
- **Role:** Redis client used by BullMQ under the hood. Configure once per app (`host`, `port`, `maxRetriesPerRequest: null` — required by BullMQ).
- **Docs:** https://github.com/redis/ioredis

**Compose service:** `redis` (image `redis:7-alpine`), reachable from inside the stack at `redis:6379` (per the Docker Networking rule in root `CLAUDE.md`).

---

## TD-02 — Upload (S3 Multipart Presigned)

### `@aws-sdk/client-s3`

- **Latest:** `3.1146.0`
- **Pin:** `^3.900.0` (any 3.x since mid-2025; the SDK is forward-compatible across minors)
- **Role:** AWS SDK v3 S3 client. Used for `CreateMultipartUploadCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `UploadPartCommand`, `GetObjectCommand`, `HeadObjectCommand`.
- **MinIO config:** `endpoint: 'http://minio:9000'`, `region: 'us-east-1'` (dummy — MinIO ignores it but SDK requires one), `forcePathStyle: true`, `credentials: { accessKeyId, secretAccessKey }` sourced from env.
- **Docs:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/s3/ and MinIO's SDK compatibility note: https://min.io/docs/minio/linux/developers/javascript/API.html

### `@aws-sdk/s3-request-presigner`

- **Latest:** `3.1146.0`
- **Pin:** same minor as `@aws-sdk/client-s3` (keep them in lockstep — SDK v3 modular packages drift otherwise).
- **Role:** `getSignedUrl(client, command, { expiresIn })` for `UploadPartCommand` (upload parts), `GetObjectCommand` (stream + download), `CompleteMultipartUploadCommand` is called server-side (not signed).
- **Docs:** https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/modules/_aws_sdk_s3_request_presigner.html

---

## TD-03 — Object storage layout (MinIO)

- **No new npm libraries** — materialized by the AWS SDK client (TD-02) + bucket bootstrap.
- **Bucket bootstrap:** one-shot `createbuckets` service in `compose.yaml` using the official `minio/mc` image (`minio/mc:latest`), which runs `mc mb` / `mc anonymous set` idempotently on container start, then exits with code 0.
- **MinIO:** image `minio/minio:latest`, started with `server /data --console-address ":9001"`. API on `9000`, console on `9001`.
- **Docs:** https://min.io/docs/minio/container/index.html and `mc` client reference https://min.io/docs/minio/linux/reference/minio-mc.html

---

## TD-04 — Worker topology

- **No new npm libraries** — composition only.
- **Docker image for `video-worker`:** base `node:22-slim`; `apt-get install -y --no-install-recommends ffmpeg` adds the `ffmpeg` and `ffprobe` binaries. Entrypoint boots a NestJS standalone application (`NestFactory.createApplicationContext(WorkerModule)`) that imports `DatabaseModule`, `StorageModule`, `QueueModule`, and the `VideoProcessor` provider.
- **Shared code:** The worker lives at `nestjs-project/video-worker/` and reuses the backend's TypeScript sources via a build-stage `COPY` (not npm workspaces — simpler, same tsconfig, no monorepo refactor needed to keep Phase 03 scoped).

---

## TD-05 — Processing pipeline (fluent-ffmpeg)

### `fluent-ffmpeg`

- **Latest:** `2.1.3`
- **Pin:** `^2.1.3`
- **Role:** Node wrapper around `ffmpeg` / `ffprobe` binaries. Fluent API for building ffmpeg command chains; promise/callback interface. Used for `ffprobe` metadata (`fluent-ffmpeg.ffprobe(path, cb)`) and single-frame thumbnail extraction (`.screenshots({ timestamps: ['50%'], filename, size })`).
- **Caveat:** Maintenance mode — stable but infrequent releases. The underlying `ffmpeg`/`ffprobe` CLIs are the real contract; the wrapper is a convenience layer. Acceptable per TD-05.
- **Docs:** https://github.com/fluent-ffmpeg/node-fluent-ffmpeg

### `@types/fluent-ffmpeg`

- **Latest:** `2.1.28`
- **Pin:** `^2.1.0`
- **Role:** TypeScript definitions. Required because `fluent-ffmpeg` ships no types.
- **Docs:** https://www.npmjs.com/package/@types/fluent-ffmpeg

### `ffmpeg` / `ffprobe` system binaries

- Installed in the `video-worker` image only (not the API image). Debian stable's `ffmpeg` package ships both.

---

## TD-06 — Streaming (presigned GET)

- **No new npm libraries** — reuses `@aws-sdk/s3-request-presigner` from TD-02.
- **Response pattern:** `GET /videos/:slug/stream` → `res.redirect(307, signedUrl)`; `GET /videos/:slug/download` → `res.redirect(307, signedUrlWithContentDisposition)`. The signed URL for download embeds `ResponseContentDisposition: 'attachment; filename="<slug>.<ext>"'` so MinIO sets the header on its own response.
- **Range support:** MinIO/S3 natively answer `Range` with `206 Partial Content` — nothing to implement in NestJS.

---

## TD-07 — Public slug (nanoid)

### `nanoid` — module-system choice

The latest `nanoid` versions are ESM-only; the backend tsconfig uses `"module": "nodenext"`, which supports ESM imports in TS source, **but** Jest with `ts-jest` defaults to CJS and would fail to load an ESM-only package without extra configuration. Three candidate pins:

- **`nanoid@^5.1.16`** — ESM-only. Import at runtime via `const { nanoid } = await import('nanoid');` inside the slug generator function. **Attempted and reverted** during SI-03.5: ts-jest's VM runtime raises `A dynamic import callback was invoked without --experimental-vm-modules`, which would require turning on `--experimental-vm-modules` project-wide and would ripple through every spec. Not worth the blast radius for a single-use import.
- **Chosen: `nanoid@^3.3.20`** — Last CJS release, still receiving security patches. Direct `import { nanoid } from 'nanoid'` works everywhere without flags. The slug generator stays synchronous. **This is the version actually installed.**
- **Avoid: `nanoid@^6.0.0`** — Published Oct 2025, too fresh to pin for a graded deliverable; revisit later.

**Status:** installed `nanoid@^3.3.20`. If the project ever moves to ESM-wide, bump to `^5` and remove the sync wrapper.

- **Docs:** https://github.com/ai/nanoid
- **Alphabet rationale (11 chars × 64):** ~1.1×10⁻⁶ collision probability at 10M videos (`nanoid` collision calculator: https://zelark.github.io/nano-id-cc/). Combined with a unique DB index + insert-retry loop, collisions are impossible to persist.

---

## TD-08 — Status machine

- **No new npm libraries** — materialized via a PostgreSQL `videos.status` enum column + BullMQ job options from TD-01 (`attempts: 3`, `backoff: { type: 'exponential', delay: 10_000 }`, `removeOnComplete: 100`, `removeOnFail: 1_000`).

---

## Infra images (Compose)

| Service | Image | Why this image |
|---------|-------|----------------|
| `minio` | `minio/minio:latest` | Official MinIO server (S3-compatible). Health endpoint `GET /minio/health/live`. |
| `createbuckets` | `minio/mc:latest` | Official MinIO client; one-shot bucket bootstrap (`mc mb` is idempotent with `--ignore-existing`). |
| `redis` | `redis:7-alpine` | Official Redis image, Alpine variant to keep the Compose stack lightweight. BullMQ 6 requires Redis ≥ 5.0; 7 is the current stable. |
| `video-worker` | custom (base `node:22-slim` + `apt-get install ffmpeg`) | Deliberate — FFmpeg is a system dependency, not an npm package. See TD-04/TD-05. |

---

## Env variables introduced by Phase 03

Appended to `nestjs-project/.env.example` and validated by `src/config/env.validation.ts`:

```ini
# MinIO / Object Storage
MINIO_ENDPOINT=http://minio:9000
MINIO_REGION=us-east-1
MINIO_ACCESS_KEY=streamtube
MINIO_SECRET_KEY=streamtube-secret
BUCKET_VIDEOS_RAW=videos-raw
BUCKET_VIDEOS_PROCESSED=videos-processed
BUCKET_THUMBNAILS=thumbnails
PRESIGN_STREAM_TTL_SECONDS=900     # 15 min (TD-06)
PRESIGN_DOWNLOAD_TTL_SECONDS=3600  # 1 h (TD-06)

# Redis / BullMQ
REDIS_HOST=redis
REDIS_PORT=6379
VIDEO_PROCESSING_QUEUE=video-processing
VIDEO_PROCESSING_ATTEMPTS=3
VIDEO_PROCESSING_BACKOFF_MS=10000
```

---

## Summary pins

| Library                        | Pin               |
|--------------------------------|-------------------|
| `@nestjs/bullmq`               | `^12.0.0`         |
| `bullmq`                       | `^6.3.0`          |
| `ioredis`                      | `^5.11.1` (peer constraint from typeorm; see TD-01 note) |
| `@aws-sdk/client-s3`           | `^3.900.0`        |
| `@aws-sdk/s3-request-presigner`| `^3.900.0`        |
| `fluent-ffmpeg`                | `^2.1.3`          |
| `@types/fluent-ffmpeg`         | `^2.1.0`          |
| `nanoid`                       | `^3.3.20` (CJS line — see TD-07 note; `^5` reverted during SI-03.5) |
