---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-05T10:59:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-05T12:55:09-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-10-05T10:59:16-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-10-05T10:59:16-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-10-05T10:59:16-03:00"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-10-05T10:59:16-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição das informações do vídeo, visibilidade pública/unlisted, fluxo de rascunho → publicação, painel de gerenciamento, página pública do canal (Fase 04); página de visualização do vídeo com player (Fase 05); comentários, likes, inscrições (Fase 06); home, busca, responsividade (Fase 07). Transcoding HLS/DASH e múltiplos bitrates ficam explicitamente fora: TD-05 limita o pipeline a metadata + thumbnail nesta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (novo módulo `videos/`, módulos de infra `storage/` e `queue/`, migration `CreateVideos`, novo processo `video-worker/`, `compose.yaml`, `.env.example`).

**Deferred subprojects:** `next-frontend/` — interface de upload, player de vídeo e botão de download são explicitamente diferidos; a Fase 03 é uma entrega de backend (API + worker + infra). As telas correspondentes serão endereçadas em fases futuras (upload UI possivelmente na Fase 04; player na Fase 05).

**Sequencing notes:** Depende de Fase 01 (ConfigModule, migrations, Docker Compose foundation) e Fase 02 (JWT guard global, DomainException/filtros, class-validator, canal como dono do vídeo).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend / Cross-layer | Message queue technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^12.0.0, bullmq@^6.3.0, ioredis@^5.11.1 |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend / Cross-layer | 10GB upload strategy | decided | A (S3 Multipart Presigned) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend / Operations | Object storage layout (buckets, keys) | decided | B (three buckets: `videos-raw`, `videos-processed`, `thumbnails`) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend / Operations | Worker topology | decided | A (Dedicated `video-worker` container) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend (worker) | Processing pipeline (metadata + thumbnail) | decided | A (`fluent-ffmpeg` — no transcoding this phase) | fluent-ffmpeg@^2.1.x, @types/fluent-ffmpeg@^2.1.x, ffmpeg/ffprobe binaries |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend / Cross-layer | Streaming delivery | decided | B (Presigned GET with 307 redirect; 15min stream / 1h download TTL) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Unique public slug per video | decided | B (`nanoid`, 11-char slug) | nanoid@^5.x |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend / Cross-layer | Status machine and failure handling | decided | A (`draft → uploading → processing → ready \| failed`; 3 attempts) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02, phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-08, phase-03-videos/TD-02 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-06 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — Smallest number of moving parts for a single-queue phase, idiomatic in NestJS, retries/backoff/concurrency out of the box, one extra Compose service (`redis`), and no cloud-provider dependency during the MBA scope. The Video Worker container will attach to the same Redis as a BullMQ `Worker`, matching the C4 "Video Worker" container exactly.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^5.x`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (Presigned Multipart) — The only shape that keeps the API out of the data path on 10GB uploads. Native in MinIO/S3, documented in the AWS SDK v3, maps naturally to the status machine (`draft → uploading → processing`), and allows horizontal scaling of the API without sticky sessions. The additional endpoints are a well-defined, small surface.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option B (three buckets) — Clean separation of concerns, independent lifecycle policies, and a path forward for public thumbnails without exposing raw uploads. The convention `<channelId>/<videoId>/<asset>` keeps keys short and makes "list all assets of a video" a cheap prefix query. The `videos-processed` bucket is pre-created but unused in this phase — it reserves the slot for future transcoding without changing the data model later.

**Libraries:** _(reuses SDK client of TD-02)_

### phase-03-videos/TD-04

**Recommendation:** Option A (Dedicated `video-worker` container) — The acceptance criteria require "fila, worker e storage reais subindo no Compose junto com o backend" and the C4 diagram models the worker as a distinct container. Dedicated topology is the correct literal reading, and it also protects API latency from FFmpeg bursts.

**Libraries:** _(composition of TD-01/02/05)_

### phase-03-videos/TD-05

**Recommendation:** Option A (`fluent-ffmpeg`) — Simpler and more testable than raw `spawn`. Maintenance-mode status is acceptable for a pin on this version; the binary surface is stable. Keep the pipeline strictly to metadata + thumbnail: the `videos-processed` bucket exists (TD-03) but stays empty in this phase, so future transcoding slots in without a migration.

**Libraries:** `fluent-ffmpeg@^2.1.x`, `@types/fluent-ffmpeg@^2.1.x`, `ffmpeg`/`ffprobe` binaries in the `video-worker` container image

### phase-03-videos/TD-06

**Recommendation:** Option B (Presigned GET with 307 redirect) — Public playback and download of a `ready` video is the dominant case; keeping the API out of the data path is the whole point. Short TTLs (15 min for streaming, 1 hour for download) bound the risk window. Owner-only previews of non-ready videos are handled by refusing to mint a URL unless the caller owns the channel; the state cycle makes this check cheap (status + channel_id in the row we already load). We stay single-path.

**Libraries:** _(reuses `@aws-sdk/s3-request-presigner` of TD-02)_

### phase-03-videos/TD-07

**Recommendation:** Option B (`nanoid`) — Standard pattern for public resource identifiers. 11 chars at a 64-char alphabet is the sweet spot for YouTube-style URLs with safe collision margins; unique index guarantees correctness. The internal UUID stays private.

**Libraries:** `nanoid@^5.x`

### phase-03-videos/TD-08

**Recommendation:** Option A — Keep `uploading` as a distinct intermediate state so the owner UI (future phase) can distinguish an abandoned draft from an in-flight upload, and so a reaper job (future) can expire orphan multipart uploads deterministically. BullMQ handles retries. Terminal `failed` state is deliberately non-recoverable in this phase (manual retry endpoint deferred).

**Libraries:** _(materialized via TD-01 BullMQ config)_

## Inherited Decisions Detail

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login.

**Note (as implemented):** Custom guards with `@nestjs/jwt` were used — a global `JwtAuthGuard` is registered as `APP_GUARD`; endpoints opt out with `@Public()`. The Videos module inherits this: owner-only endpoints are protected by default, playback/download endpoints opt into `@Public()` for anonymous streaming of `ready` videos.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Documented NestJS approach; aligns with decorator usage project-wide.

**Applied to Phase 03:** DTOs under `src/videos/dto/` (e.g., `CreateVideoDto`, `RequestPartUrlsDto`, `CompleteUploadDto`) validate request bodies; global `ValidationPipe` is already active.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Machine-readable error codes consumed by the frontend.

**Applied to Phase 03:** New domain errors (`VIDEO_NOT_FOUND`, `NOT_CHANNEL_OWNER`, `UPLOAD_ALREADY_COMPLETED`, `VIDEO_NOT_READY`, `INVALID_STATUS_TRANSITION`, etc.) extend `DomainException`; filter maps them to the standard `ApiErrorEnvelope`.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — In-memory, module-scoped guard.

**Applied to Phase 03:** Upload-lifecycle endpoints keep the global throttler default (10 req/60s). The streaming/download redirect endpoints keep the default too — scaling concern lives at MinIO, not the API, since the API only mints presigned URLs.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official module; `registerAs()` factory solves CLI sharing.

**Applied to Phase 03:** New config modules `src/config/storage.config.ts` (endpoint, access key, secret key, bucket names, presigned TTLs) and `src/config/queue.config.ts` (Redis host/port, queue name) follow the same `registerAs` pattern.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration via `validationSchema`.

**Applied to Phase 03:** `src/config/env.validation.ts` gains entries for `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_REGION`, `BUCKET_VIDEOS_RAW`, `BUCKET_VIDEOS_PROCESSED`, `BUCKET_THUMBNAILS`, `PRESIGN_STREAM_TTL_SECONDS`, `PRESIGN_DOWNLOAD_TTL_SECONDS`, `REDIS_HOST`, `REDIS_PORT`, `VIDEO_PROCESSING_QUEUE`, `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS`.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced with registerAs).

**Applied to Phase 03:** New namespaces: `storage`, `queue`. Each with its own `registerAs` factory file.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI, worker standalone bootstrap). _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory; `TypeOrmModule.forRootAsync` with `autoLoadEntities: true` and `synchronize: false`. _(from phase 01)_
- Migrations live in `src/database/migrations/` with the timestamped class pattern `Create<Thing><Timestamp>` and raw-SQL `queryRunner.query(...)` in both `up` and `down`. _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top and reuses the shared config factories. _(from phase 01)_
- JWT auth is global via `APP_GUARD` with `JwtAuthGuard`; endpoints opt out via `@Public()`; the authenticated user is injected with `@CurrentUser()`. _(from phase 02)_
- Business errors extend `DomainException` and are mapped by `DomainExceptionFilter` to the `ApiErrorEnvelope` DTO (`{ statusCode, error, message, code? }`). `ValidationExceptionFilter` normalizes `BadRequestException` payloads. _(from phase 02)_
- DTOs use `class-validator` decorators; `ValidationPipe` is global with `whitelist: true, forbidNonWhitelisted: true, transform: true`. _(from phase 02)_
- Rate limiting is global via `@nestjs/throttler` as `APP_GUARD` (10 req/60s default); endpoints override with `@Throttle()` or opt out with `@SkipThrottle()`. _(from phase 02)_
- OpenAPI documentation is produced via `@nestjs/swagger` decorators on controllers/DTOs; the schema is exported via `npm run openapi:export` to `openapi.json`. _(from phase 02)_
- Docker-internal hostnames use Compose service names (`db`, `mailpit`, soon `minio`, `redis`), never `localhost`. _(from phase 01, reinforced in `CLAUDE.md`)_
- Tests follow the pyramid with suffixes `*.spec.ts` (unit), `*.integration-spec.ts` (real infra — DB, SMTP, soon MinIO/Redis), `*.e2e-spec.ts` (full HTTP via supertest). `--runInBand` is mandatory for integration/e2e. _(from phases 01-02)_

## Inherited Deferred Capabilities

| Capability (prior phase) | Status | Rationale | Resolution in Phase 03 |
|---------------------------|--------|-----------|-------------------------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha (Fase 02) | deferred | `next-frontend/` is not initialized. | Still deferred — out of scope for Fase 03 which is backend-only. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Interface de upload de vídeos (frontend) | deferred | `next-frontend/` is not initialized; a dedicated frontend phase ships upload UI. | — |
| Player de vídeo (frontend) | deferred | Fase 05 — Página de Visualização do Vídeo. | — |
| Botão de download no frontend | deferred | Fase 05 — Página de Visualização do Vídeo. | — |
| Transcoding HLS/DASH / múltiplos bitrates | explicitly out of scope | Not listed in Fase 03 capabilities; TD-05 freezes the pipeline at metadata + thumbnail. The `videos-processed` bucket is reserved for future transcodes. | phase-03-videos/TD-05 |
| Manual retry endpoint for failed processing | explicitly out of scope | Beyond Fase 03 acceptance criteria; added later without data model change. | phase-03-videos/TD-08 |
| Orphan multipart upload reaper (scheduled cleanup) | explicitly out of scope | A simple MinIO lifecycle policy or future cron suffices; not required to meet the acceptance criteria of Fase 03. | phase-03-videos/TD-03, phase-03-videos/TD-08 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 adds HTTP endpoints, a dedicated worker process, and real external infrastructure (MinIO, Redis). Each layer is exercised:

- **Unit (`*.spec.ts`):** services with mocked AWS SDK / BullMQ / ffmpeg; DTO validation; nanoid-based slug generator; status-machine transitions.
- **Integration (`*.integration-spec.ts`):** real PostgreSQL (migrations + entity CRUD), real MinIO (presigned URLs resolve, multipart init/complete/abort end-to-end against the running bucket), real Redis (job enqueue / processor registration), and worker end-to-end (fixture video uploaded → job executed → row flips to `ready` with thumbnail bytes present in the thumbnails bucket).
- **E2E (`*.e2e-spec.ts`):** full HTTP via supertest for the upload lifecycle, 307 redirect assertions for stream/download, and 206 Partial Content when ultimately performing a Range request against MinIO through the signed URL.

Real infrastructure is used wherever Compose provides it — mocks are only acceptable for layers above the SDK/driver line. Specific layer coverage by SI is recorded in `progress.md`.
