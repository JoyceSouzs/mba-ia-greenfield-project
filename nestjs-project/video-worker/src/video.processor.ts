import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import storageConfig from '../../src/config/storage.config';
import { VIDEO_PROCESSING_QUEUE_NAME } from '../../src/queue/queue.constants';
import type {
  VideoProcessingJobData,
  VideoProcessingJobResult,
} from '../../src/queue/video-processing.job';
import { StorageService } from '../../src/storage/storage.service';
import { VideoProcessingService } from '../../src/videos/video-processing.service';

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string | number;
}

interface FfprobeOutput {
  format?: {
    duration?: string | number;
    format_name?: string;
    bit_rate?: string | number;
  };
  streams?: FfprobeStream[];
}

function parseFfprobe(data: FfprobeOutput): {
  durationSeconds: number;
  metadata: Record<string, unknown>;
} {
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const duration = Number(data.format?.duration ?? 0);
  const metadata: Record<string, unknown> = {
    container: data.format?.format_name,
    bitRate: data.format?.bit_rate ? Number(data.format.bit_rate) : undefined,
    width: video?.width,
    height: video?.height,
    codecName: video?.codec_name,
  };
  return { durationSeconds: Math.round(duration), metadata };
}

async function runFfprobe(file: string): Promise<FfprobeOutput> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(data as FfprobeOutput);
    });
  });
}

async function extractThumbnail(
  input: string,
  outDir: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const filename = 'thumb.jpg';
    ffmpeg(input)
      .on('end', () => resolve(path.join(outDir, filename)))
      .on('error', (err) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      )
      .screenshots({
        timestamps: ['50%'],
        filename,
        folder: outDir,
        size: '640x?',
      });
  });
}

@Processor(VIDEO_PROCESSING_QUEUE_NAME)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly storage: StorageService,
    private readonly videoProcessing: VideoProcessingService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {
    super();
  }

  async process(
    job: Job<VideoProcessingJobData>,
  ): Promise<VideoProcessingJobResult> {
    const { videoId, channelId, rawObjectKey } = job.data;
    this.logger.log(
      `Processing video ${videoId} (attempt ${job.attemptsMade + 1}/${
        job.opts.attempts ?? 1
      })`,
    );

    const status = await this.videoProcessing.getStatus(videoId);
    if (status !== 'processing') {
      this.logger.warn(
        `Skipping job for video ${videoId}: current status is ${status ?? 'missing'}`,
      );
      return {
        durationSeconds: 0,
        thumbnailObjectKey: '',
        metadata: {},
      };
    }

    const workDir = path.join(os.tmpdir(), 'video-worker', videoId);
    const inputFile = path.join(workDir, 'raw');

    try {
      await mkdir(workDir, { recursive: true });

      // Confirm the raw object exists before downloading.
      await this.storage.headObject({
        bucket: this.storageCfg.bucketVideosRaw,
        key: rawObjectKey,
      });

      // Signed GET → stream to disk.
      const signedUrl = await this.storage.signGetObjectUrl({
        bucket: this.storageCfg.bucketVideosRaw,
        key: rawObjectKey,
        expiresInSeconds: this.storageCfg.presignStreamTtlSeconds,
      });
      const response = await fetch(signedUrl);
      if (!response.ok) {
        throw new Error(
          `MinIO download failed: ${response.status} ${response.statusText}`,
        );
      }
      const arrayBuf = await response.arrayBuffer();
      await writeFile(inputFile, Buffer.from(arrayBuf));

      // ffprobe for metadata
      const probe = await runFfprobe(inputFile);
      const { durationSeconds, metadata } = parseFfprobe(probe);

      // ffmpeg for thumbnail
      const thumbPath = await extractThumbnail(inputFile, workDir);
      const thumbBytes = await readFile(thumbPath);
      const thumbnailObjectKey = `${channelId}/${videoId}/thumb.jpg`;
      await this.storage.putObject({
        bucket: this.storageCfg.bucketThumbnails,
        key: thumbnailObjectKey,
        body: thumbBytes,
        contentType: 'image/jpeg',
      });

      await this.videoProcessing.markReady({
        videoId,
        durationSeconds,
        thumbnailObjectKey,
        metadata,
      });

      this.logger.log(
        `Video ${videoId} ready: duration=${durationSeconds}s, thumbnail=${thumbnailObjectKey}`,
      );
      return { durationSeconds, thumbnailObjectKey, metadata };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade + 1 >= attempts) {
        this.logger.error(
          `Video ${videoId} failed after ${attempts} attempts: ${message}`,
        );
        await this.videoProcessing.markFailed(videoId, message);
      } else {
        this.logger.warn(
          `Video ${videoId} attempt ${job.attemptsMade + 1} failed, will retry: ${message}`,
        );
      }
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {
        /* ignore cleanup errors */
      });
    }
  }
}
