import { Test } from '@nestjs/testing';
import { mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import storageConfig from '../../src/config/storage.config';
import { StorageService } from '../../src/storage/storage.service';
import { VideoProcessingService } from '../../src/videos/video-processing.service';
import { VideoProcessor } from './video.processor';

// Mock fluent-ffmpeg before importing the processor.
jest.mock('fluent-ffmpeg', () => {
  type FfprobeCallback = (
    err: Error | null,
    data?: {
      format?: { duration?: number; format_name?: string; bit_rate?: number };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
      }>;
    },
  ) => void;

  interface Chain {
    on: jest.Mock;
    screenshots: jest.Mock;
  }

  const chain: Chain = {
    on: jest.fn(),
    screenshots: jest.fn(),
  };

  // Each .on() returns the same chain to allow .on().on().screenshots()
  chain.on.mockImplementation(function (
    this: Chain,
    event: string,
    cb: () => void,
  ) {
    if (event === 'end') {
      // Trigger thumbnail-ready callback synchronously-ish.
      setTimeout(cb, 0);
    }
    return chain;
  });
  chain.screenshots.mockImplementation(function (this: Chain) {
    return chain;
  });

  const factory = jest.fn(() => chain) as unknown as {
    ffprobe: jest.Mock;
  } & jest.Mock;

  factory.ffprobe = jest.fn((_file: string, cb: FfprobeCallback) => {
    cb(null, {
      format: { duration: 42.7, format_name: 'mp4', bit_rate: 1200000 },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
      ],
    });
  });

  return factory;
});

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

describe('VideoProcessor (unit)', () => {
  let processor: VideoProcessor;
  let storage: {
    headObject: jest.Mock;
    signGetObjectUrl: jest.Mock;
    putObject: jest.Mock;
  };
  let videoProcessing: {
    getStatus: jest.Mock;
    markReady: jest.Mock;
    markFailed: jest.Mock;
  };
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    storage = {
      headObject: jest.fn().mockResolvedValue({ contentLength: 1024 }),
      signGetObjectUrl: jest
        .fn()
        .mockResolvedValue('http://minio/signed-get-url'),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    videoProcessing = {
      getStatus: jest.fn().mockResolvedValue('processing'),
      markReady: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };

    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    } as unknown as Response);

    // Pre-create thumb file so readFile() succeeds — the mock resolves 'end'
    // callback but does not actually write a file.
    const workDir = path.join(os.tmpdir(), 'video-worker', 'test-video-id');
    await mkdir(workDir, { recursive: true });
    await writeFile(path.join(workDir, 'thumb.jpg'), Buffer.from([0xff, 0xd8]));

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingService, useValue: videoProcessing },
        { provide: storageConfig.KEY, useValue: TEST_STORAGE_CONFIG },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function makeJob(
    attemptsMade = 0,
    attempts = 3,
  ): {
    data: { videoId: string; channelId: string; rawObjectKey: string };
    attemptsMade: number;
    opts: { attempts: number };
  } {
    return {
      data: {
        videoId: 'test-video-id',
        channelId: 'ch-1',
        rawObjectKey: 'ch-1/test-video-id/raw',
      },
      attemptsMade,
      opts: { attempts },
    };
  }

  it('happy path: downloads, probes, extracts thumb, uploads it, marks ready', async () => {
    const result = await processor.process(
      makeJob() as unknown as Parameters<typeof processor.process>[0],
    );

    expect(storage.headObject).toHaveBeenCalledWith({
      bucket: 'videos-raw',
      key: 'ch-1/test-video-id/raw',
    });
    expect(storage.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'thumbnails',
        key: 'ch-1/test-video-id/thumb.jpg',
        contentType: 'image/jpeg',
      }),
    );
    expect(videoProcessing.markReady).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'test-video-id',
        durationSeconds: 43,
        thumbnailObjectKey: 'ch-1/test-video-id/thumb.jpg',
      }),
    );
    expect(result.durationSeconds).toBe(43);
    expect(result.metadata).toMatchObject({
      width: 1920,
      height: 1080,
      codecName: 'h264',
    });
  });

  it('skips idempotently when status is not processing', async () => {
    videoProcessing.getStatus.mockResolvedValue('ready');

    const result = await processor.process(
      makeJob() as unknown as Parameters<typeof processor.process>[0],
    );
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(videoProcessing.markReady).not.toHaveBeenCalled();
    expect(result.durationSeconds).toBe(0);
  });

  it('intermediate attempt failure: throws but does NOT mark failed', async () => {
    storage.headObject.mockRejectedValue(new Error('boom'));

    await expect(
      processor.process(
        makeJob(0, 3) as unknown as Parameters<typeof processor.process>[0],
      ),
    ).rejects.toThrow('boom');

    expect(videoProcessing.markFailed).not.toHaveBeenCalled();
  });

  it('terminal attempt failure: marks video as failed with the reason', async () => {
    storage.headObject.mockRejectedValue(new Error('terminal'));

    await expect(
      processor.process(
        makeJob(2, 3) as unknown as Parameters<typeof processor.process>[0],
      ),
    ).rejects.toThrow('terminal');

    expect(videoProcessing.markFailed).toHaveBeenCalledWith(
      'test-video-id',
      'terminal',
    );
  });
});
