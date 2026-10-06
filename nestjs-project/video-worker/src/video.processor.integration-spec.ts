import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../src/auth/entities/refresh-token.entity';
import { VerificationToken } from '../../src/auth/entities/verification-token.entity';
import { Channel } from '../../src/channels/entities/channel.entity';
import databaseConfig from '../../src/config/database.config';
import queueConfig from '../../src/config/queue.config';
import storageConfig from '../../src/config/storage.config';
import { StorageModule } from '../../src/storage/storage.module';
import { StorageService } from '../../src/storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../src/test/create-test-data-source';
import { User } from '../../src/users/entities/user.entity';
import { Video } from '../../src/videos/entities/video.entity';
import { VideoProcessingService } from '../../src/videos/video-processing.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const FIXTURE_PATH = path.join(
  __dirname,
  '..',
  '..',
  'test',
  'fixtures',
  'sample.mp4',
);

function hasFfmpeg(): boolean {
  try {
    execSync('ffprobe -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIfFfmpeg = hasFfmpeg() ? describe : describe.skip;

describeIfFfmpeg('VideoProcessor (integration — real DB + MinIO + ffmpeg)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let processor: VideoProcessor;
  let videoRepo: Repository<Video>;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessor, VideoProcessingService],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    storage = moduleRef.get(StorageService);
    processor = moduleRef.get(VideoProcessor);
    videoRepo = dataSource.getRepository(Video);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;

  async function seedProcessingVideo(): Promise<Video> {
    const user = await userRepo.save(
      userRepo.create({
        email: `wk_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'ch',
        nickname: `wk_${counter}`,
        user_id: user.id,
      }),
    );
    const bytes = await readFile(FIXTURE_PATH);
    const videoId = crypto.randomUUID();
    const rawObjectKey = `${channel.id}/${videoId}/raw`;
    await storage.putObject({
      bucket: process.env.BUCKET_VIDEOS_RAW ?? 'videos-raw',
      key: rawObjectKey,
      body: bytes,
      contentType: 'video/mp4',
    });
    const video = await videoRepo.save(
      videoRepo.create({
        id: videoId,
        channel_id: channel.id,
        title: 'wk video',
        status: 'processing',
        public_slug: `wk_${counter}_${Date.now().toString().slice(-6)}`,
        raw_object_key: rawObjectKey,
        multipart_upload_id: null,
      }),
    );
    return video;
  }

  it('end-to-end: processing → ready with duration + thumbnail stored in MinIO', async () => {
    const video = await seedProcessingVideo();

    const job = {
      data: {
        videoId: video.id,
        channelId: video.channel_id,
        rawObjectKey: video.raw_object_key,
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    };

    const result = await processor.process(
      job as unknown as Parameters<typeof processor.process>[0],
    );

    expect(result.durationSeconds).toBeGreaterThanOrEqual(2);
    expect(result.durationSeconds).toBeLessThanOrEqual(4);
    expect(result.thumbnailObjectKey).toBe(
      `${video.channel_id}/${video.id}/thumb.jpg`,
    );

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe('ready');
    expect(updated.duration_seconds).toBe(result.durationSeconds);
    expect(updated.thumbnail_object_key).toBe(result.thumbnailObjectKey);
    expect(updated.metadata).toMatchObject({
      width: 320,
      height: 240,
      codecName: 'h264',
    });

    const thumbHead = await storage.headObject({
      bucket: process.env.BUCKET_THUMBNAILS ?? 'thumbnails',
      key: result.thumbnailObjectKey,
    });
    expect(thumbHead.contentLength).toBeGreaterThan(100);
    expect(thumbHead.contentType).toBe('image/jpeg');
  }, 60000);

  it('terminal failure: marks video as failed with the reason after attempts exhausted', async () => {
    const user = await userRepo.save(
      userRepo.create({
        email: `wk_fail@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'ch',
        nickname: 'wk_fail',
        user_id: user.id,
      }),
    );
    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        title: 't',
        status: 'processing',
        public_slug: 'wk_fail_slg',
        raw_object_key: `${channel.id}/missing/raw`, // raw was never uploaded
        multipart_upload_id: null,
      }),
    );

    const job = {
      data: {
        videoId: video.id,
        channelId: channel.id,
        rawObjectKey: video.raw_object_key,
      },
      attemptsMade: 2,
      opts: { attempts: 3 },
    };

    await expect(
      processor.process(
        job as unknown as Parameters<typeof processor.process>[0],
      ),
    ).rejects.toThrow();

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe('failed');
    expect(updated.failed_reason).toBeTruthy();
  }, 30000);
});
