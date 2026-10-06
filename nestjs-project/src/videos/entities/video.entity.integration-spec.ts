import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  let slugCounter = 0;
  async function createVideo(
    channel: Channel,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Sample',
        public_slug: overrides.public_slug ?? `slug_${++slugCounter}`,
        raw_object_key: `${channel.id}/sample/raw`,
        ...overrides,
      }),
    );
  }

  it('persists a video with status defaulting to draft', async () => {
    const channel = await createChannel();
    const video = await createVideo(channel);
    expect(video.status).toBe('draft');
    expect(video.id).toBeDefined();
    expect(video.created_at).toBeInstanceOf(Date);
  });

  it('enforces unique public_slug constraint', async () => {
    const channel = await createChannel();
    await createVideo(channel, { public_slug: 'duplicate_x' });
    await expect(
      createVideo(channel, { public_slug: 'duplicate_x' }),
    ).rejects.toThrow();
  });

  it('rejects videos whose channel_id does not reference an existing channel', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          title: 'orphan',
          public_slug: 'orphan_slug',
          raw_object_key: 'orphan/raw',
        }),
      ),
    ).rejects.toThrow();
  });

  it('cascades delete when the owning channel is removed', async () => {
    const channel = await createChannel();
    const video = await createVideo(channel, { public_slug: 'cascade_slug' });
    await channelRepository.delete(channel.id);
    const found = await videoRepository.findOne({ where: { id: video.id } });
    expect(found).toBeNull();
  });

  it('rejects videos with an invalid status enum value', async () => {
    const channel = await createChannel();
    await expect(
      dataSource.query(
        `INSERT INTO "videos"(channel_id, title, status, public_slug, raw_object_key)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          channel.id,
          'invalid status video',
          'not-a-valid-status',
          'inv_slug_1',
          'inv/raw',
        ],
      ),
    ).rejects.toThrow();
  });

  it('persists metadata as jsonb and reads it back', async () => {
    const channel = await createChannel();
    const metadata = { width: 1920, height: 1080, codec: 'h264' };
    const video = await createVideo(channel, {
      public_slug: 'meta_slug',
      metadata,
    });
    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.metadata).toEqual(metadata);
  });

  it('allows nullable fields (thumbnail, duration, metadata, multipart, failed_reason)', async () => {
    const channel = await createChannel();
    const video = await createVideo(channel, { public_slug: 'nulls_slug' });
    const found = await videoRepository.findOneByOrFail({ id: video.id });
    expect(found.thumbnail_object_key).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.multipart_upload_id).toBeNull();
    expect(found.failed_reason).toBeNull();
  });

  it('loads the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await createVideo(channel, { public_slug: 'rel_slug' });
    const found = await videoRepository.findOne({
      where: { public_slug: 'rel_slug' },
      relations: ['channel'],
    });
    expect(found?.channel.id).toBe(channel.id);
    expect(found?.channel.nickname).toBe(channel.nickname);
  });
});
