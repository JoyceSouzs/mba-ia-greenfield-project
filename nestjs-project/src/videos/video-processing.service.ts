import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Video } from './entities/video.entity';
import type { VideoStatus } from './entities/video-status.enum';

export interface MarkReadyInput {
  videoId: string;
  durationSeconds: number;
  thumbnailObjectKey: string;
  metadata: Record<string, unknown>;
}

@Injectable()
export class VideoProcessingService {
  constructor(
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
  ) {}

  async getStatus(videoId: string): Promise<VideoStatus | null> {
    const row = await this.videoRepo.findOne({
      where: { id: videoId },
      select: ['status'],
    });
    return row?.status ?? null;
  }

  async loadForProcessing(videoId: string): Promise<Video | null> {
    return this.videoRepo.findOne({ where: { id: videoId } });
  }

  async markReady(input: MarkReadyInput): Promise<void> {
    await this.videoRepo.query(
      `UPDATE "videos"
       SET "status" = 'ready',
           "duration_seconds" = $1,
           "thumbnail_object_key" = $2,
           "metadata" = $3::jsonb,
           "failed_reason" = NULL,
           "updated_at" = NOW()
       WHERE "id" = $4`,
      [
        input.durationSeconds,
        input.thumbnailObjectKey,
        JSON.stringify(input.metadata),
        input.videoId,
      ],
    );
  }

  async markFailed(videoId: string, reason: string): Promise<void> {
    await this.videoRepo.update(
      { id: videoId },
      {
        status: 'failed',
        failed_reason: reason,
      },
    );
  }
}
