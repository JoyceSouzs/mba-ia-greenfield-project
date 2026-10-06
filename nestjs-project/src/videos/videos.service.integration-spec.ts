import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
};

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + MinIO + Redis)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  let service: VideosService;
  let drainQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, Channel]),
        StorageModule,
        QueueModule,
      ],
      providers: [VideosService],
    }).compile();

    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);

    drainQueue = new Queue(VIDEO_PROCESSING_QUEUE_NAME, {
      connection: REDIS_CONNECTION,
    });
    await drainQueue.drain(true);
  });

  afterAll(async () => {
    await drainQueue.drain(true);
    await drainQueue.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await drainQueue.drain(true);
  });

  let counter = 0;
  async function createOwnedChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `videos_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `Ch ${counter}`,
        nickname: `svc_ch_${counter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  async function putPart(url: string, body: Buffer): Promise<string> {
    const r = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    if (!r.ok) throw new Error(`PUT failed ${r.status}`);
    const etag = r.headers.get('etag');
    if (!etag) throw new Error('no etag');
    return etag;
  }

  it('full happy path: create → requestPartUrls → PUT → complete → enqueued', async () => {
    const { user, channel } = await createOwnedChannel();

    const created = await service.createVideo({
      channelId: channel.id,
      userId: user.id,
      title: 'Integration Video',
      contentType: 'application/octet-stream',
    });

    const draft = await videoRepo.findOneByOrFail({ id: created.videoId });
    expect(draft.status).toBe('draft');
    expect(draft.public_slug).toBe(created.publicSlug);
    expect(draft.multipart_upload_id).toBe(created.uploadId);

    const [part1, part2] = await service.requestPartUrls({
      videoId: created.videoId,
      userId: user.id,
      partNumbers: [1, 2],
    });

    const after = await videoRepo.findOneByOrFail({ id: created.videoId });
    expect(after.status).toBe('uploading');

    const body1 = Buffer.alloc(6 * 1024 * 1024, 0xab);
    const body2 = Buffer.from('tail-bytes');
    const etag1 = await putPart(part1.url, body1);
    const etag2 = await putPart(part2.url, body2);

    await service.completeUpload({
      videoId: created.videoId,
      userId: user.id,
      parts: [
        { partNumber: 1, eTag: etag1 },
        { partNumber: 2, eTag: etag2 },
      ],
    });

    const final = await videoRepo.findOneByOrFail({ id: created.videoId });
    expect(final.status).toBe('processing');
    expect(final.multipart_upload_id).toBeNull();

    const jobs = await drainQueue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const payload = jobs[0].data as {
      videoId: string;
      channelId: string;
      rawObjectKey: string;
    };
    expect(payload.videoId).toBe(created.videoId);
    expect(payload.channelId).toBe(channel.id);
  }, 60000);

  it('abort path: create → abort removes DB row and clears MinIO multipart', async () => {
    const { user, channel } = await createOwnedChannel();
    const created = await service.createVideo({
      channelId: channel.id,
      userId: user.id,
      title: 'To abort',
    });

    await service.abortUpload({
      videoId: created.videoId,
      userId: user.id,
    });

    const row = await videoRepo.findOne({ where: { id: created.videoId } });
    expect(row).toBeNull();
  }, 30000);
});
