import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (unit)', () => {
  let service: VideoProcessingService;
  let repo: {
    findOne: jest.Mock;
    update: jest.Mock;
    query: jest.Mock;
  };

  beforeEach(async () => {
    repo = {
      findOne: jest.fn(),
      update: jest.fn(),
      query: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        { provide: getRepositoryToken(Video), useValue: repo },
      ],
    }).compile();
    service = module.get(VideoProcessingService);
  });

  describe('getStatus', () => {
    it('returns the status when the row exists', async () => {
      repo.findOne.mockResolvedValue({ status: 'processing' });
      await expect(service.getStatus('v1')).resolves.toBe('processing');
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'v1' },
        select: ['status'],
      });
    });

    it('returns null when the row is missing', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getStatus('nope')).resolves.toBeNull();
    });
  });

  describe('markReady', () => {
    it('issues parameterized UPDATE with jsonb cast for metadata', async () => {
      repo.query.mockResolvedValue(undefined);
      await service.markReady({
        videoId: 'v1',
        durationSeconds: 42,
        thumbnailObjectKey: 'ch/v1/thumb.jpg',
        metadata: { width: 1920, height: 1080 },
      });
      expect(repo.query).toHaveBeenCalledTimes(1);
      const calls = repo.query.mock.calls as Array<[string, unknown[]]>;
      const [sql, params] = calls[0];
      expect(sql).toContain('UPDATE "videos"');
      expect(sql).toContain(`"status" = 'ready'`);
      expect(sql).toContain('"metadata" = $3::jsonb');
      expect(params[0]).toBe(42);
      expect(params[1]).toBe('ch/v1/thumb.jpg');
      expect(params[2]).toBe(JSON.stringify({ width: 1920, height: 1080 }));
      expect(params[3]).toBe('v1');
    });
  });

  describe('markFailed', () => {
    it('calls update with status=failed and the reason', async () => {
      repo.update.mockResolvedValue({ affected: 1 });
      await service.markFailed('v1', 'ffprobe exploded');
      expect(repo.update).toHaveBeenCalledWith(
        { id: 'v1' },
        { status: 'failed', failed_reason: 'ffprobe exploded' },
      );
    });
  });
});
