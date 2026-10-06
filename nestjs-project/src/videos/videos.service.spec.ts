import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidStatusTransitionException,
  NotChannelOwnerException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
} from './exceptions/videos.exceptions';
import { VideosService } from './videos.service';

const TEST_STORAGE_CONFIG = {
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  accessKey: 'x',
  secretKey: 'y',
  bucketVideosRaw: 'videos-raw',
  bucketVideosProcessed: 'videos-processed',
  bucketThumbnails: 'thumbnails',
  presignStreamTtlSeconds: 900,
  presignDownloadTtlSeconds: 3600,
};

const USER_ID = '00000000-0000-4000-8000-00000000aaaa';
const OTHER_USER_ID = '00000000-0000-4000-8000-00000000bbbb';
const CHANNEL_ID = '00000000-0000-4000-8000-000000000001';
const VIDEO_ID = '00000000-0000-4000-8000-000000000002';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: CHANNEL_ID,
    name: 'Chan',
    nickname: 'chan',
    description: null,
    user_id: USER_ID,
    created_at: new Date(),
    updated_at: new Date(),
    user: {} as never,
    ...overrides,
  } as Channel;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: VIDEO_ID,
    channel_id: CHANNEL_ID,
    title: 't',
    status: 'draft',
    public_slug: 'slug12345ab',
    raw_object_key: `${CHANNEL_ID}/${VIDEO_ID}/raw`,
    multipart_upload_id: 'upload-id',
    thumbnail_object_key: null,
    duration_seconds: null,
    metadata: null,
    failed_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: makeChannel(),
    ...overrides,
  } as Video;
}

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepo: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let channelRepo: { findOne: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    signUploadPartUrls: jest.Mock;
    completeMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
  };
  let producer: { enqueue: jest.Mock };

  beforeEach(async () => {
    videoRepo = {
      findOne: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };
    channelRepo = { findOne: jest.fn() };
    storage = {
      createMultipartUpload: jest.fn(),
      signUploadPartUrls: jest.fn(),
      completeMultipartUpload: jest.fn(),
      abortMultipartUpload: jest.fn(),
    };
    producer = { enqueue: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: getRepositoryToken(Channel), useValue: channelRepo },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
        { provide: storageConfig.KEY, useValue: TEST_STORAGE_CONFIG },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('createVideo', () => {
    it('creates a draft row, calls MinIO, and returns upload metadata', async () => {
      channelRepo.findOne.mockResolvedValue(makeChannel());
      storage.createMultipartUpload.mockResolvedValue({ uploadId: 'up-1' });
      videoRepo.insert.mockResolvedValue({});

      const result = await service.createVideo({
        channelId: CHANNEL_ID,
        userId: USER_ID,
        title: 'My Video',
        contentType: 'video/mp4',
      });

      expect(result.bucket).toBe('videos-raw');
      expect(result.rawObjectKey).toMatch(
        new RegExp(`^${CHANNEL_ID}/[a-f0-9-]{36}/raw$`),
      );
      expect(result.uploadId).toBe('up-1');
      expect(result.publicSlug).toHaveLength(11);
      expect(storage.createMultipartUpload).toHaveBeenCalledWith({
        bucket: 'videos-raw',
        key: result.rawObjectKey,
        contentType: 'video/mp4',
      });
      expect(videoRepo.insert).toHaveBeenCalledTimes(1);
      const calls = videoRepo.insert.mock.calls as Array<
        [{ status: string; multipart_upload_id: string }]
      >;
      const insertArg = calls[0][0];
      expect(insertArg.status).toBe('draft');
      expect(insertArg.multipart_upload_id).toBe('up-1');
    });

    it('throws ChannelNotFoundException when channel is missing', async () => {
      channelRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createVideo({
          channelId: CHANNEL_ID,
          userId: USER_ID,
          title: 't',
        }),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
    });

    it('throws NotChannelOwnerException when the caller is not the channel owner', async () => {
      channelRepo.findOne.mockResolvedValue(makeChannel());
      await expect(
        service.createVideo({
          channelId: CHANNEL_ID,
          userId: OTHER_USER_ID,
          title: 't',
        }),
      ).rejects.toBeInstanceOf(NotChannelOwnerException);
    });

    it('retries slug generation on unique-constraint violation', async () => {
      channelRepo.findOne.mockResolvedValue(makeChannel());
      storage.createMultipartUpload.mockResolvedValue({ uploadId: 'up' });
      // First insert fails with unique violation on public_slug, second succeeds.
      const err = new QueryFailedError('q', [], new Error()) as unknown as {
        code: string;
        detail: string;
      };
      err.code = '23505';
      err.detail = 'Key (public_slug)=(dupxyz) already exists';
      videoRepo.insert.mockRejectedValueOnce(err).mockResolvedValueOnce({});

      const result = await service.createVideo({
        channelId: CHANNEL_ID,
        userId: USER_ID,
        title: 't',
      });

      expect(videoRepo.insert).toHaveBeenCalledTimes(2);
      expect(result.publicSlug).toHaveLength(11);
    });
  });

  describe('requestPartUrls', () => {
    it('loads the video, signs URLs, and transitions draft→uploading on first call', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'draft' }));
      storage.signUploadPartUrls.mockResolvedValue([
        { partNumber: 1, url: 'u1', expiresAt: new Date() },
      ]);

      const result = await service.requestPartUrls({
        videoId: VIDEO_ID,
        userId: USER_ID,
        partNumbers: [1],
      });

      expect(result).toHaveLength(1);
      expect(videoRepo.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        { status: 'uploading' },
      );
    });

    it('does not re-update status when already uploading', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'uploading' }));
      storage.signUploadPartUrls.mockResolvedValue([]);

      await service.requestPartUrls({
        videoId: VIDEO_ID,
        userId: USER_ID,
        partNumbers: [1],
      });

      expect(videoRepo.update).not.toHaveBeenCalled();
    });

    it('throws VideoNotFoundException for an unknown videoId', async () => {
      videoRepo.findOne.mockResolvedValue(null);
      await expect(
        service.requestPartUrls({
          videoId: VIDEO_ID,
          userId: USER_ID,
          partNumbers: [1],
        }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws NotChannelOwnerException when the caller is not the channel owner', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo());
      await expect(
        service.requestPartUrls({
          videoId: VIDEO_ID,
          userId: OTHER_USER_ID,
          partNumbers: [1],
        }),
      ).rejects.toBeInstanceOf(NotChannelOwnerException);
    });

    it('rejects when status is not draft/uploading', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'processing' }));
      await expect(
        service.requestPartUrls({
          videoId: VIDEO_ID,
          userId: USER_ID,
          partNumbers: [1],
        }),
      ).rejects.toBeInstanceOf(InvalidStatusTransitionException);
    });
  });

  describe('completeUpload', () => {
    it('completes multipart, transitions to processing, clears upload id, enqueues job', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'uploading' }));
      storage.completeMultipartUpload.mockResolvedValue({ location: 'ok' });

      await service.completeUpload({
        videoId: VIDEO_ID,
        userId: USER_ID,
        parts: [{ partNumber: 1, eTag: '"e"' }],
      });

      expect(videoRepo.update).toHaveBeenCalledWith(
        { id: VIDEO_ID },
        { status: 'processing', multipart_upload_id: null },
      );
      expect(producer.enqueue).toHaveBeenCalledWith({
        videoId: VIDEO_ID,
        channelId: CHANNEL_ID,
        rawObjectKey: expect.stringContaining(CHANNEL_ID) as string,
      });
    });

    it('rejects when status is not uploading', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'draft' }));
      await expect(
        service.completeUpload({
          videoId: VIDEO_ID,
          userId: USER_ID,
          parts: [{ partNumber: 1, eTag: 'e' }],
        }),
      ).rejects.toBeInstanceOf(UploadAlreadyCompletedException);
    });
  });

  describe('abortUpload', () => {
    it('aborts MinIO multipart and deletes the row', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'uploading' }));
      await service.abortUpload({ videoId: VIDEO_ID, userId: USER_ID });
      expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(videoRepo.delete).toHaveBeenCalledWith({ id: VIDEO_ID });
    });

    it('rejects when status is processing/ready/failed', async () => {
      videoRepo.findOne.mockResolvedValue(makeVideo({ status: 'processing' }));
      await expect(
        service.abortUpload({ videoId: VIDEO_ID, userId: USER_ID }),
      ).rejects.toBeInstanceOf(InvalidStatusTransitionException);
    });
  });
});
