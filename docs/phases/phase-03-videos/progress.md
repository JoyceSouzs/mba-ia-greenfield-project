# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/8 completed

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

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._

---

## SI-03.4 — Queue Module (`src/queue/`) — BullMQ Wiring and Job Contract

**Status:** pending

**Tests:** _not yet run_

**Observations:** _none yet._

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
