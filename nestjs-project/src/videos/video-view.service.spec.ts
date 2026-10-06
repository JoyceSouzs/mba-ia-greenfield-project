import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/videos.exceptions';
import { VideoViewService } from './video-view.service';

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

const OWNER_ID = 'owner-1';
const STRANGER_ID = 'stranger-1';
const SLUG = 'slug_abcdef';

function makeVideo(
  status: Video['status'],
  overrides: Partial<Video> = {},
): Video {
  return {
    id: 'v1',
    channel_id: 'ch-1',
    title: 'My Video',
    status,
    public_slug: SLUG,
    raw_object_key: 'ch-1/v1/raw',
    multipart_upload_id: null,
    thumbnail_object_key: 'ch-1/v1/thumb.jpg',
    duration_seconds: 42,
    metadata: { container: 'mp4', width: 1920, height: 1080 },
    failed_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: {
      id: 'ch-1',
      user_id: OWNER_ID,
    } as never,
    ...overrides,
  } as Video;
}

describe('VideoViewService (unit)', () => {
  let service: VideoViewService;
  let repo: { findOne: jest.Mock };
  let storage: { signGetObjectUrl: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    storage = {
      signGetObjectUrl: jest.fn().mockResolvedValue('http://minio/signed'),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoViewService,
        { provide: getRepositoryToken(Video), useValue: repo },
        { provide: StorageService, useValue: storage },
        { provide: storageConfig.KEY, useValue: TEST_STORAGE_CONFIG },
      ],
    }).compile();
    service = module.get(VideoViewService);
  });

  describe('getMetadata', () => {
    it('returns metadata with thumbnailUrl for a ready video (anonymous)', async () => {
      repo.findOne.mockResolvedValue(makeVideo('ready'));
      const result = await service.getMetadata(SLUG, null);
      expect(result).toEqual({
        slug: SLUG,
        title: 'My Video',
        status: 'ready',
        durationSeconds: 42,
        thumbnailUrl: 'http://minio/signed',
      });
      expect(storage.signGetObjectUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'thumbnails',
          key: 'ch-1/v1/thumb.jpg',
          expiresInSeconds: 900,
        }),
      );
    });

    it('hides a processing video from anonymous callers (404)', async () => {
      repo.findOne.mockResolvedValue(makeVideo('processing'));
      await expect(service.getMetadata(SLUG, null)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('hides a processing video from a stranger (404)', async () => {
      repo.findOne.mockResolvedValue(makeVideo('processing'));
      await expect(
        service.getMetadata(SLUG, STRANGER_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('reveals a processing video to the owner', async () => {
      repo.findOne.mockResolvedValue(
        makeVideo('processing', {
          thumbnail_object_key: null,
        }),
      );
      const result = await service.getMetadata(SLUG, OWNER_ID);
      expect(result.status).toBe('processing');
      expect(result.thumbnailUrl).toBeNull();
    });

    it('throws VideoNotFoundException for unknown slug', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getMetadata(SLUG, null)).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });
  });

  describe('getStreamUrl', () => {
    it('returns a signed URL for a ready video', async () => {
      repo.findOne.mockResolvedValue(makeVideo('ready'));
      const url = await service.getStreamUrl(SLUG, null);
      expect(url).toBe('http://minio/signed');
      expect(storage.signGetObjectUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: 'videos-raw',
          key: 'ch-1/v1/raw',
          expiresInSeconds: 900,
        }),
      );
    });

    it('refuses non-ready videos even for the owner (VideoNotReady)', async () => {
      repo.findOne.mockResolvedValue(makeVideo('processing'));
      await expect(service.getStreamUrl(SLUG, OWNER_ID)).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('attaches Content-Disposition with sanitized filename and .mp4 extension', async () => {
      repo.findOne.mockResolvedValue(
        makeVideo('ready', {
          title: 'My "Video" with \nnewlines',
          metadata: { container: 'mp4' },
        }),
      );
      await service.getDownloadUrl(SLUG, null);
      const calls = storage.signGetObjectUrl.mock.calls as Array<
        [{ responseContentDisposition: string; expiresInSeconds: number }]
      >;
      const call = calls[0][0];
      expect(call.expiresInSeconds).toBe(3600);
      expect(call.responseContentDisposition).toMatch(
        /^attachment; filename="My Video with newlines\.mp4"$/,
      );
    });

    it('refuses non-ready videos', async () => {
      repo.findOne.mockResolvedValue(makeVideo('failed'));
      await expect(
        service.getDownloadUrl(SLUG, OWNER_ID),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });
});
