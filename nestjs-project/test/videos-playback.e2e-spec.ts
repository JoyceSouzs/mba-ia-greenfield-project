import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'sample.mp4',
);

describe('Videos Playback (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let counter = 0;

  async function seedReadyVideo(): Promise<{ slug: string }> {
    counter++;
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const videoRepo = dataSource.getRepository(Video);
    const user = await userRepo.save(
      userRepo.create({
        email: `playback_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'ch',
        nickname: `pb_ch_${counter}`,
        user_id: user.id,
      }),
    );
    const bytes = await readFile(FIXTURE_PATH);
    const videoId = crypto.randomUUID();
    const rawKey = `${channel.id}/${videoId}/raw`;
    const thumbKey = `${channel.id}/${videoId}/thumb.jpg`;
    await storage.putObject({
      bucket: process.env.BUCKET_VIDEOS_RAW ?? 'videos-raw',
      key: rawKey,
      body: bytes,
      contentType: 'video/mp4',
    });
    await storage.putObject({
      bucket: process.env.BUCKET_THUMBNAILS ?? 'thumbnails',
      key: thumbKey,
      body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      contentType: 'image/jpeg',
    });
    const slug = `pbslg${counter}_x`;
    await videoRepo.save(
      videoRepo.create({
        id: videoId,
        channel_id: channel.id,
        title: 'Playback Video',
        status: 'ready',
        public_slug: slug,
        raw_object_key: rawKey,
        thumbnail_object_key: thumbKey,
        duration_seconds: 3,
        metadata: { container: 'mp4', width: 320, height: 240 },
      }),
    );
    return { slug };
  }

  it('GET /videos/:slug returns metadata with thumbnailUrl for a ready video', async () => {
    const { slug } = await seedReadyVideo();
    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}`)
      .expect(200);
    const body = res.body as {
      slug: string;
      status: string;
      durationSeconds: number;
      thumbnailUrl: string;
    };
    expect(body.slug).toBe(slug);
    expect(body.status).toBe('ready');
    expect(body.durationSeconds).toBe(3);
    expect(body.thumbnailUrl).toMatch(/^https?:\/\//);
  });

  it('GET /videos/:slug for unknown slug returns 404', async () => {
    await request(app.getHttpServer()).get('/videos/does_not_x').expect(404);
  });

  it('GET /videos/:slug/stream 307-redirects to a signed URL that answers 206 Partial Content on Range', async () => {
    const { slug } = await seedReadyVideo();
    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(307);
    const location = res.headers['location'];
    expect(location).toMatch(/^https?:\/\//);
    expect(location).toContain('videos-raw');

    const partial = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(partial.status).toBe(206);
    const contentRange = partial.headers.get('content-range');
    expect(contentRange).toMatch(/^bytes 0-1023\/\d+/);
  });

  it('GET /videos/:slug/download 307-redirects to a signed URL with Content-Disposition attachment', async () => {
    const { slug } = await seedReadyVideo();
    const res = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .expect(307);
    const location = res.headers['location'];
    expect(location).toContain('response-content-disposition');
    expect(location).toContain('attachment');

    const full = await fetch(location);
    expect(full.ok).toBe(true);
    expect(full.headers.get('content-disposition')).toContain('attachment');
    expect(full.headers.get('content-disposition')).toContain('.mp4');
  });

  it('GET /videos/:slug/stream for an unknown slug returns 404 VIDEO_NOT_FOUND (anonymous)', async () => {
    const res = await request(app.getHttpServer())
      .get('/videos/missing_x/stream')
      .expect(404);
    const body = res.body as { error: string };
    expect(body.error).toBe('VIDEO_NOT_FOUND');
  });
});
