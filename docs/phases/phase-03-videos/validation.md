---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
date: 2026-10-05
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None — every bullet in Fase 03 (project-plan.md lines 73-81) is traceable to one or more TDs in `technical-decisions-phase-03-videos.md`._

Trace:

- "Serviço de armazenamento de arquivos (vídeos e thumbnails)" → TD-02 (upload path produces the bytes in storage) + TD-03 (bucket layout for both videos and thumbnails).
- "Serviço de processamento em segundo plano (filas)" → TD-01 (queue) + TD-04 (worker container).
- "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" → TD-02 + TD-03.
- "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" → TD-08 (initial `draft` state) + TD-02 (multipart init endpoint that creates the row).
- "Processamento automático do vídeo após upload (extração de duração e metadados)" → TD-01, TD-04, TD-05, TD-08.
- "Geração automática de thumbnail a partir de um frame do vídeo" → TD-05 (ffmpeg frame extraction) + TD-03 (thumbnail bucket).
- "URL única por vídeo, sem conflito com outros vídeos" → TD-07 (`nanoid` slug + unique index).
- "Reprodução via streaming (sem necessidade de download completo)" → TD-06 (presigned GET with HTTP Range).
- "Download do vídeo pelo usuário" → TD-06 (presigned GET with `Content-Disposition: attachment`).

### Dependency Gaps

_None._

The pipeline is linearizable:

- TD-03 (bucket layout) must land before TD-02 is operational (SDK calls require bucket names).
- TD-02 (presigned multipart) must land before TD-08's `uploading → processing` transition fires.
- TD-01 (queue) must land before TD-04 (worker is a BullMQ `Worker` instance that targets the queue).
- TD-04 (dedicated worker container) must land before TD-05 (FFmpeg lives in the worker image).
- TD-05 must land before TD-08's `processing → ready | failed` transition.
- TD-06 reuses artifacts from TD-02 (same SDK) and TD-07 (slug as the public identifier in the stream/download routes); both must land first.

These dependencies translate 1:1 to the SI order enforced by `plan-build` (see upcoming `phase-03-videos.md`).

### Inherited Constraint Conflicts

_None._

The Fase 03 decisions comply with all inherited conventions:

- Config modules (`storage`, `queue`) use `registerAs` and feed `env.validation.ts` (phase-01-configuracao-base/TD-01…TD-03).
- Owner-only endpoints are protected by the global `JwtAuthGuard`; public playback/download endpoints opt out with `@Public()` (phase-02-auth/TD-02).
- Business errors extend `DomainException` and surface the standard `ApiErrorEnvelope` (phase-02-auth/TD-07).
- DTOs validated via `class-validator` under the already-global `ValidationPipe` (phase-02-auth/TD-06).
- Rate-limiting default applies; no bypass is required by Fase 03 (phase-02-auth/TD-08).
- New Compose services (`minio`, `redis`, `video-worker`) are reached by their Compose service names from inside the stack (`CLAUDE.md`, Docker Networking section).
- Tests follow the pyramid with the three suffixes; real infra (MinIO, Redis, PostgreSQL) is exercised instead of mocked wherever Compose provides it (phase-01/02 convention + Fase 03 acceptance criteria "não mocke o que dá para testar de verdade").

### Unresolved Open Questions

_None._

Items that could superficially look open but are actually resolved by TDs:

- Streaming authorization for anonymous users — resolved by TD-06 (public playback for `ready` videos; non-`ready` states refuse to mint a URL unless the caller owns the channel).
- Expiry of presigned URLs — resolved by TD-06 (15 min stream, 1 h download) and enforced via `PRESIGN_STREAM_TTL_SECONDS` / `PRESIGN_DOWNLOAD_TTL_SECONDS` in `env.validation.ts`.
- Maximum part size / minimum part size for multipart — fixed by the S3 protocol (5 MB min / 5 GB max per part; 10 K parts max). The API honors these as hard limits; the plan references them explicitly in `plan-build`'s Error Catalog.
- Retry policy on worker failure — resolved by TD-01 BullMQ `attempts: 3, backoff: exponential 10 s`; terminal transition to `failed` by TD-08.
- Manual retry of a failed video — explicitly deferred (TD-08 Option C) and documented in `context.md` under "Non-UI / Deferred Capabilities".

### UI Coverage Gaps

_Not applicable to this phase — Fase 03 is backend-only._

The project-plan bullet list for Fase 03 contains no UI item (`Tela`, `Página`, `Interface`). The challenge statement explicitly scopes out the frontend ("A interface de vídeo não faz parte do escopo desta fase"). All UI deferrals are declared in `context.md` → "Non-UI / Deferred Capabilities" (upload UI, player, download button).

### Capability Coverage

All 9 capabilities from `docs/project-plan.md` Fase 03 are listed under `## Capability Coverage` in `context.md` and have at least one TD mapping.

## Resolved Issues

_None in this iteration — validation closed clean on first pass._

## Verdict

**Status:** `clean` — ready for `plan-resolve` (library pinning) and then `plan-build`.
