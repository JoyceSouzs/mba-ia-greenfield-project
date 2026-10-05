---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-05
scope_description: "Backend foundation for video lifecycle: object storage (S3-compatible), background job queue, dedicated FFmpeg worker container, 10GB upload strategy that keeps the API responsive, automatic metadata/thumbnail processing, unique public slug per video, HTTP range streaming, download, and a persisted status machine with retry/failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend module `videos/` (upload lifecycle endpoints, playback, download), shared infrastructure modules `storage/` and `queue/`, migration for the `videos` table, and a sibling `video-worker/` process that consumes the processing queue and runs FFmpeg.
- `nestjs-project/compose.yaml` — new services: MinIO (object storage), a one-shot bucket bootstrap job, Redis (queue backend), and `video-worker` (FFmpeg container).
- `next-frontend/` — Frontend deferred: upload UI, player and download controls (`Interface de upload, player de vídeo e botão de download`) are out of scope for this phase; a future phase addresses them. No open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend / Cross-layer (API + worker share the queue contract)

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload

**Context:** The project-plan explicitly leaves the queue technology as TBD (see `docs/diagrams/software-arch.mermaid`: `ContainerQueue(queue, "Message Queue", "TBD", ...)`). The queue is the backbone of the phase: the API publishes a `video.process` job on upload completion, and a separate worker consumes it to extract metadata and generate a thumbnail. The choice drives both API-side (producer) and worker-side (consumer) code, retry semantics, and the Compose topology.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq` + `bullmq` + `ioredis`)
- Node-native job queue backed by Redis. First-class NestJS integration (`@nestjs/bullmq` registers producers via `BullModule.registerQueue` and consumers via `@Processor` classes). Built-in retries with exponential backoff, delayed jobs, concurrency per worker, job events, dead-letter via `attempts` exhaustion.
- **Pros:** Lowest friction in the current Node/NestJS stack. One extra Compose service (`redis`). Rich NestJS docs and community examples. Retry/backoff/concurrency configured declaratively. Redis also unlocks caching later (ThrottlerModule already lives alongside it conceptually). Observability via BullMQ events + optional UI (Bull Board).
- **Cons:** Not an AMQP broker — single-broker topology; cross-service pub/sub is less idiomatic than RabbitMQ. Redis adds one new piece of infra to operate (memory sizing, persistence config). Message durability depends on Redis persistence settings (AOF).

### Option B: RabbitMQ (`amqplib` + `@golevelup/nestjs-rabbitmq`)
- Classic AMQP broker. Exchanges, queues, routing keys, acknowledgments, dead-letter exchanges. Mature multi-consumer / multi-worker topologies.
- **Pros:** Battle-tested broker with strong durability and routing semantics. Scales to many producers/consumers and multi-service pub/sub. Dead-letter exchanges are first-class.
- **Cons:** Overkill for the single `video.process` queue of Phase 03. More operational surface (Erlang-based broker, management UI, policies). More setup code (channel/exchange/queue declarations, consumer wiring). Worse NestJS ergonomics — the community packages are good but less canonical than BullMQ.

### Option C: AWS SQS (`@aws-sdk/client-sqs` + `@ssut/nestjs-sqs`)
- Managed cloud queue. No local broker to run — but local dev needs ElasticMQ or LocalStack to emulate.
- **Pros:** Zero ops in production. Scales elastically. Decouples the project from Redis/RabbitMQ ops.
- **Cons:** Requires an emulator in Docker for dev (LocalStack ≈ 500MB image; ElasticMQ is lighter but less featureful). Fewer scheduling primitives than BullMQ (no first-class delayed/retry with backoff — must be built on top). Vendor lock-in for prod.

**Recommendation:** **Option A (BullMQ + Redis)** — Smallest number of moving parts for a single-queue phase, idiomatic in NestJS, retries/backoff/concurrency out of the box, one extra Compose service (`redis`), and no cloud-provider dependency during the MBA scope. The Video Worker container will attach to the same Redis as a BullMQ `Worker`, matching the C4 "Video Worker" container exactly.

**Decision:** A (BullMQ + Redis)

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`

---

## TD-02: 10GB Upload Strategy

**Scope:** Backend / Cross-layer (contract shapes the client as well, when a frontend ships)

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** The acceptance criteria forbid "passing the 10GB file through the API in a way that locks the system". The upload strategy drives API responsiveness, memory profile, scalability, and recoverability. Three realistic shapes exist: push through the API in streaming mode, resumable protocol via a TUS server, or direct-to-storage via S3 multipart presigned URLs.

**Options:**

### Option A: S3 Multipart Upload with Presigned URLs (direct-to-storage)
- API endpoints only mint a multipart `uploadId` and emit presigned `UploadPart` URLs. The client PUTs each part straight to MinIO. On completion, the client calls the API, which issues `CompleteMultipartUpload` to MinIO. The file never traverses the API process.
- **Pros:** API never buffers or streams the payload — Node event loop stays free regardless of file size. Scales horizontally without sticky sessions. MinIO/S3 natively support 10K parts × 5GB/part. Native resume (re-request a missing part URL). Mature AWS SDK v3 support (`@aws-sdk/s3-request-presigner`).
- **Cons:** More endpoints and more client-side logic (initiate → request part URLs → PUT parts → complete / abort). Credential-free uploads require pre-signature policy (bucket + method + expiry). Abort flow is required to avoid orphan multipart uploads (lifecycle policy mitigates this).

### Option B: TUS Resumable Upload (`@tus/server`)
- Open protocol for resumable uploads. A TUS server runs alongside the API (or inside it) and persists chunks. A post-finish hook moves the final file to S3.
- **Pros:** First-class resumability over flaky networks. Clean client protocol (one HTTP interaction model). Mature browser clients (`tus-js-client`).
- **Cons:** Adds a second server surface or a sub-mount of the API — the API still handles the bytes. Extra move/copy step from TUS temp storage to S3 (double I/O). Weaker fit with MinIO than native multipart. More infra to size (TUS disk, timeouts).

### Option C: Stream the upload through the API to the Storage
- Multer in stream mode (or raw stream in a controller) pipes the request body into an S3 PUT. Simple.
- **Pros:** Simplest implementation, fewest endpoints. One HTTP request from client's point of view.
- **Cons:** Holds a Node connection for hours on a 10GB file. One Node process can realistically serve a handful of concurrent uploads before saturating. Hard to scale: timeouts, proxies (nginx) must be configured for huge bodies. Violates the acceptance criterion ("passing the 10GB file through the API in a way that locks the system").

**Recommendation:** **Option A (Presigned Multipart)** — The only shape that keeps the API out of the data path on 10GB uploads. Native in MinIO/S3, documented in the AWS SDK v3, maps naturally to the status machine (`draft → uploading → processing`), and allows horizontal scaling of the API without sticky sessions. The additional endpoints are a well-defined, small surface.

**Decision:** A (Presigned Multipart Upload)

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

---

## TD-03: Object Storage Layout (buckets, keys, lifecycle)

**Scope:** Backend / Operations

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Object storage is pre-selected by the project (S3-compatible; MinIO in dev, see `docs/diagrams/software-arch.mermaid`: `ContainerDb(storage, "Object Storage", "S3 or MinIO", ...)`). The open design decision is how to lay out buckets and keys so that uploads, processing, playback and download are each isolated, cheap to permission, and easy to list/clean. It also sets what the `videos` table stores in `raw_object_key` / `thumbnail_object_key`.

**Options:**

### Option A: Single bucket, path-prefixed by role (`streamtube/videos/<channelId>/<videoId>/raw.<ext>` and `.../thumb.jpg`)
- One bucket (`streamtube`), all assets inside, role encoded in the key prefix.
- **Pros:** Fewest moving parts. Single bucket policy. Easier to backup/restore as a unit.
- **Cons:** Harder to apply different lifecycle policies (keep raw forever? expire incomplete uploads?). Mixed-sensitivity assets in one bucket (public thumbnails next to raw uploads).

### Option B: Three buckets split by role (`videos-raw`, `videos-processed`, `thumbnails`)
- Three buckets with distinct policies: `videos-raw` holds the uploaded original; `videos-processed` is reserved for future transcodes (empty in this phase, see TD-05); `thumbnails` holds the generated JPEG.
- **Pros:** Lifecycle policies per bucket (e.g., abort-incomplete-multipart on `videos-raw`). Clearer access control (thumbnails bucket could be made publicly readable later; `videos-raw` never is). Keys inside each bucket stay short (`<channelId>/<videoId>/<asset>`). Matches the C4 diagram's expected granularity.
- **Cons:** Three bucket resources to create and keep in sync. Slightly more config.

### Option C: Bucket per channel
- One bucket per channel.
- **Pros:** Hard-isolated per tenant.
- **Cons:** AWS has a 100-bucket soft limit per account; non-starter at platform scale. Significant setup/teardown overhead per channel.

**Recommendation:** **Option B (three buckets)** — Clean separation of concerns, independent lifecycle policies, and a path forward for public thumbnails without exposing raw uploads. The convention `<channelId>/<videoId>/<asset>` keeps keys short and makes "list all assets of a video" a cheap prefix query. The `videos-processed` bucket is pre-created but unused in this phase — it reserves the slot for future transcoding without changing the data model later.

**Decision:** B (three buckets: `videos-raw`, `videos-processed`, `thumbnails`)

**Libraries:** _No new libraries — materialized via the SDK client of TD-02._

---

## TD-04: Worker Topology

**Scope:** Backend / Operations

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload

**Context:** The C4 diagram models the Video Worker as its own container. FFmpeg is CPU/memory-intensive; co-locating it with the API would starve HTTP handlers under load. The open question is whether to materialize the diagram literally (dedicated container) or collapse it into the API process for Phase 03's small-footprint goals.

**Options:**

### Option A: Dedicated `video-worker` container (separate Compose service)
- Separate service in `compose.yaml` with its own Dockerfile (base `node:22-slim` + `ffmpeg` apt install). Starts a Nest standalone application (`NestFactory.createApplicationContext`) that boots only the `QueueModule`, `StorageModule`, `DatabaseModule`, and a BullMQ `Worker` for `video-processing`. Shares the backend's `src/` via a Docker build-stage or workspace layout.
- **Pros:** Matches the C4 diagram exactly. FFmpeg CPU bursts never touch the API. Scales independently (`--scale video-worker=N`). Clear operational boundary (crash of worker ≠ crash of API). Easy to add Prometheus/healthcheck on the worker alone.
- **Cons:** One more container to build (bigger image due to FFmpeg). Shared code requires either a monorepo workspace layout or copying `src/` into the worker image.

### Option B: In-process worker (BullMQ Worker started inside the Nest API)
- The API process registers a BullMQ `Worker` for `video-processing` and processes jobs in the same Node runtime.
- **Pros:** No new container. Simplest Compose. Shares code trivially.
- **Cons:** FFmpeg (spawned as child_process) competes with the API for CPU/RSS. Hard to scale the worker independently of the API. Does not match the C4 diagram, which the acceptance criteria explicitly reference ("fila, worker e storage reais subindo no Compose").

**Recommendation:** **Option A (dedicated container)** — The acceptance criteria require "fila, worker e storage reais subindo no Compose junto com o backend" and the C4 diagram models the worker as a distinct container. Dedicated topology is the correct literal reading, and it also protects API latency from FFmpeg bursts.

**Decision:** A (Dedicated `video-worker` container)

**Libraries:** _Composition only — reuses libraries from TD-01, TD-02, TD-05._

---

## TD-05: Video Processing Pipeline (metadata + thumbnail)

**Scope:** Backend (worker)

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The worker must extract duration and basic metadata, and produce one thumbnail per video. The question is which binary and which Node wrapper, and whether to produce additional artifacts (transcodes) in this phase.

**Options:**

### Option A: `ffprobe` for metadata + `ffmpeg` for thumbnail, invoked via `fluent-ffmpeg`
- `ffprobe -v error -show_format -show_streams -of json <input>` parses to a typed metadata record (duration, width, height, codec, bitrate). `ffmpeg -ss <t> -i <input> -frames:v 1 -q:v 3 <out>.jpg` extracts a frame at a mid-point timestamp. `fluent-ffmpeg` wraps both.
- **Pros:** Mature library (`fluent-ffmpeg` is the most-used Node wrapper). Nicer API than raw `child_process`. Streams supported for input/output. Easy to unit-test by stubbing the chain.
- **Cons:** `fluent-ffmpeg` is in maintenance mode (sparse recent releases). Still works, but less active. One extra dependency.

### Option B: Direct `node:child_process spawn` to the `ffmpeg` and `ffprobe` binaries
- No wrapper — the worker builds the arg vector and spawns the binary. Parses `ffprobe` JSON output directly.
- **Pros:** Zero dependencies. Full control over the arg vector and stdio handling.
- **Cons:** Boilerplate (stdio pumping, error channel, exit-code checks) duplicated across call sites. Easier to introduce subtle bugs (quoting, signal handling).

### Option C: Full transcoding pipeline (HLS/DASH, multi-bitrate)
- In addition to metadata + thumbnail, produce HLS variants and store them in `videos-processed`.
- **Pros:** Enables adaptive streaming out of the box.
- **Cons:** Not in the Phase 03 scope (`docs/project-plan.md` lists only metadata + thumbnail + streaming). Adds hours of CPU per video, requires playlist generation, player work on the frontend. Would blow the phase's definition of done.

**Recommendation:** **Option A (`fluent-ffmpeg`)** — Simpler and more testable than raw `spawn`. Maintenance-mode status is acceptable for a pin on this version; the binary surface is stable. Keep the pipeline strictly to metadata + thumbnail: the `videos-processed` bucket exists (TD-03) but stays empty in this phase, so future transcoding slots in without a migration.

**Decision:** A (`fluent-ffmpeg` for metadata + thumbnail only — no transcoding in this phase)

**Libraries:** `fluent-ffmpeg@^2.1.x`, `@types/fluent-ffmpeg@^2.1.x`, plus the `ffmpeg`/`ffprobe` binaries installed in the `video-worker` container image.

---

## TD-06: Streaming Delivery

**Scope:** Backend / Cross-layer (shapes the client playback contract)

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Playback must not require a full download. HTTP Range Requests (`Range: bytes=N-M` → `206 Partial Content`) are the universal mechanism. The implementation question is whether the API acts as a proxy on every request, or redirects the client to a presigned GET URL served directly by MinIO/S3 (which supports Range natively). Download is the same choice with `Content-Disposition: attachment`.

**Options:**

### Option A: API proxy with Range forwarding
- `GET /videos/:slug/stream` sets `Content-Type` and streams bytes from MinIO back to the client, forwarding the `Range` header.
- **Pros:** Fine-grained authorization per-request (API can check status/visibility on every chunk request). URL stays under the project's domain. No signed URLs to manage.
- **Cons:** API is in the data path on every byte range — scales poorly for concurrent streams. Doubles bandwidth usage (storage → API → client).

### Option B: Presigned GET URL (API returns 307 redirect; client fetches directly from MinIO)
- `GET /videos/:slug/stream` issues `getSignedUrl(GetObjectCommand, { expiresIn })` and returns `307 Temporary Redirect`. The client (or `<video>` tag) performs the `Range` requests directly against MinIO, which answers `206`.
- **Pros:** API out of the data path. MinIO/S3 handle Range natively — zero code to maintain. Scales to many concurrent streams for free. Download works identically with `ResponseContentDisposition: attachment; filename="..."` baked into the presigned URL.
- **Cons:** Signed URL grants read access for its TTL — rotation after revocation is only effective after TTL expiry. Authorization is coarse-grained (checked at URL issuance, not per chunk).

### Option C: Hybrid — presigned for public `ready` videos; proxy only for `draft/processing/failed` and owner-only reads
- Default to presigned; fall back to proxy when the request needs per-request authorization (e.g., the owner previewing a `draft`).
- **Pros:** Combines scalability (public playback) with fine-grained control (owner-only states).
- **Cons:** Two code paths. More tests.

**Recommendation:** **Option B (Presigned GET with 307 redirect)** — Public playback and download of a `ready` video is the dominant case; keeping the API out of the data path is the whole point. Short TTLs (e.g., 15 min for streaming, 1 hour for download) bound the risk window. Owner-only previews of non-ready videos are handled by refusing to mint a URL unless the caller owns the channel; the state cycle makes this check cheap (status + channel_id in the row we already load). We stay single-path.

**Decision:** B (Presigned GET URL with HTTP 307 redirect; TTLs: 15min stream / 1h download)

**Libraries:** _Reuses `@aws-sdk/s3-request-presigner` from TD-02._

---

## TD-07: Unique Public Slug per Video

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique public identifier used in all public routes (`/videos/:slug`, `/videos/:slug/stream`, `/videos/:slug/download`). It must be separate from the internal UUID `id` to avoid enumeration and to keep URLs short. The choice drives the DB column, index, and the generator.

**Options:**

### Option A: UUID v4 as the public slug
- Reuse the primary key UUID directly.
- **Pros:** No new generator. No new column.
- **Cons:** 36-char URL. Enumeration-safe but ugly. Couples internal identifier to the public URL — leaks the primary key.

### Option B: `nanoid` short slug (e.g., 11 chars, URL-safe)
- Generate an 11-character slug from a 64-char alphabet (`A-Za-z0-9_-`). ~132 bits of entropy at 21 chars; at 11 chars still ~65 bits — collision-safe at platform scale (<1 in 10^18 with 10M videos). Stored in `public_slug VARCHAR(16) UNIQUE NOT NULL`.
- **Pros:** Short, YouTube-style URLs. URL-safe without encoding. Public identifier decoupled from internal primary key. Industry-standard choice for public slugs. Collisions handled with a unique-constraint-aware retry loop at insert time.
- **Cons:** New dependency (`nanoid`). Needs a unique index.

### Option C: Base62-encoded auto-incremented BigInt
- Encode a sequence counter in base62.
- **Pros:** Monotonic, short.
- **Cons:** Reveals creation order and total video count — enumerable. Not acceptable for public URLs.

**Recommendation:** **Option B (`nanoid`)** — Standard pattern for public resource identifiers. 11 chars at a 64-char alphabet is the sweet spot for YouTube-style URLs with safe collision margins; unique index guarantees correctness. The internal UUID stays private.

**Decision:** B (`nanoid`, 11-char public slug stored in `videos.public_slug`)

**Libraries:** `nanoid@^5.x` (ESM — import via `createRequire` or dynamic import if CJS context is needed; verify at `plan-resolve` time)

---

## TD-08: Status Machine and Failure Handling

**Scope:** Backend / Cross-layer (API transitions on upload events; worker transitions on processing outcomes)

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload

**Context:** The video row has a status column observed by every API consumer (owner dashboards eventually, public pages immediately). The question is what the states are, which actor owns each transition, and how retries interact with the terminal `failed` state. Failures must be observable (owner needs to know "why").

**Options:**

### Option A: `draft → uploading → processing → ready | failed` with BullMQ-managed retries
- States and transitions:
  - `draft` — row created by `POST /channels/:id/videos` (multipart initiated, zero parts uploaded yet).
  - `uploading` — set when the first `POST /videos/:id/parts` is successfully called (optional; may be elided if we only track `draft` vs `processing`).
  - `processing` — set by `POST /videos/:id/complete` after `CompleteMultipartUpload` succeeds and the job is enqueued.
  - `ready` — set by the worker on successful metadata + thumbnail write.
  - `failed` — set by the worker on terminal failure (BullMQ `attempts` exhausted). `failed_reason` populated.
- BullMQ: `attempts: 3`, `backoff: { type: 'exponential', delay: 10_000 }`, `removeOnComplete: 100`, `removeOnFail: 1_000`.
- **Pros:** Linear machine, easy to render in UI. Terminal failure state carries a human-readable reason. Retries handled by BullMQ, not by domain code.
- **Cons:** `uploading` is observable in DB only once first-part activity happens; useful but not strictly required.

### Option B: Collapsed states `draft → processing → ready | failed`
- Elide `uploading`; the row stays in `draft` through the entire multipart.
- **Pros:** Simpler state set (4 values). Fewer transitions.
- **Cons:** No signal to the eventual UI that the client is actively uploading vs. abandoned the draft. Harder to reap orphans.

### Option C: Reactivation path from `failed` → `processing` (manual retry endpoint)
- Owner can POST a retry; worker runs again. Adds an endpoint and a counter.
- **Pros:** Recoverable failures.
- **Cons:** Beyond Phase 03's acceptance criteria. Easy to add later without migration.

**Recommendation:** **Option A** — Keep `uploading` as a distinct intermediate state so the owner UI (future phase) can distinguish an abandoned draft from an in-flight upload, and so a reaper job (future) can expire orphan multipart uploads deterministically. BullMQ handles retries. Terminal `failed` state is deliberately non-recoverable in this phase (option C deferred).

**Decision:** A (`draft → uploading → processing → ready | failed`; retries: 3 attempts, exponential 10s backoff)

**Libraries:** _No new libraries — materialized via the state column + BullMQ config of TD-01._

---

## Decisions Summary

| ID    | Scope                   | Topic                                          | Status  | Decision                                                              | Libraries                                                                                                 |
|-------|-------------------------|------------------------------------------------|---------|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| TD-01 | Backend / Cross-layer   | Message queue technology                       | decided | A (BullMQ + Redis)                                                    | `@nestjs/bullmq`, `bullmq`, `ioredis`                                                                     |
| TD-02 | Backend / Cross-layer   | 10GB upload strategy                           | decided | A (S3 Multipart Presigned)                                            | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`                                                     |
| TD-03 | Backend / Operations    | Object storage layout (buckets, keys)          | decided | B (three buckets: `videos-raw`, `videos-processed`, `thumbnails`)     | _(reuses SDK of TD-02)_                                                                                   |
| TD-04 | Backend / Operations    | Worker topology                                | decided | A (Dedicated `video-worker` container)                                | _(composition of TD-01/02/05)_                                                                            |
| TD-05 | Backend (worker)        | Processing pipeline (metadata + thumbnail)     | decided | A (`fluent-ffmpeg` — no transcoding this phase)                       | `fluent-ffmpeg`, `@types/fluent-ffmpeg`, `ffmpeg`/`ffprobe` binaries in worker image                      |
| TD-06 | Backend / Cross-layer   | Streaming delivery                             | decided | B (Presigned GET with 307 redirect; 15min stream / 1h download TTL)   | _(reuses `@aws-sdk/s3-request-presigner` of TD-02)_                                                       |
| TD-07 | Backend                 | Unique public slug per video                   | decided | B (`nanoid`, 11-char slug in `videos.public_slug`)                    | `nanoid`                                                                                                  |
| TD-08 | Backend / Cross-layer   | Status machine and failure handling            | decided | A (`draft → uploading → processing → ready \| failed`; 3 attempts)    | _(materialized via TD-01 BullMQ config)_                                                                  |
