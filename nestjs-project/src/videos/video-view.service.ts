import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from './exceptions/videos.exceptions';

export interface VideoMetadata {
  slug: string;
  title: string;
  status: Video['status'];
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

const CONTAINER_TO_EXT: Record<string, string> = {
  mp4: 'mp4',
  'mov,mp4,m4a,3gp,3g2,mj2': 'mp4',
  webm: 'webm',
  matroska: 'mkv',
  'matroska,webm': 'mkv',
};

function pickExtension(metadata: Record<string, unknown> | null): string {
  const container =
    typeof metadata?.container === 'string' ? metadata.container : undefined;
  return (container && CONTAINER_TO_EXT[container]) || 'mp4';
}

@Injectable()
export class VideoViewService {
  constructor(
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async getMetadata(
    slug: string,
    callerUserId: string | null,
  ): Promise<VideoMetadata> {
    const video = await this.loadVisibleBySlug(slug, callerUserId);
    const thumbnailUrl = video.thumbnail_object_key
      ? await this.storage.signGetObjectUrl({
          bucket: this.storageCfg.bucketThumbnails,
          key: video.thumbnail_object_key,
          expiresInSeconds: this.storageCfg.presignStreamTtlSeconds,
        })
      : null;
    return {
      slug: video.public_slug,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      thumbnailUrl,
    };
  }

  async getStreamUrl(
    slug: string,
    callerUserId: string | null,
  ): Promise<string> {
    const video = await this.loadVisibleBySlug(slug, callerUserId);
    if (video.status !== 'ready') throw new VideoNotReadyException();
    return this.storage.signGetObjectUrl({
      bucket: this.storageCfg.bucketVideosRaw,
      key: video.raw_object_key,
      expiresInSeconds: this.storageCfg.presignStreamTtlSeconds,
    });
  }

  async getDownloadUrl(
    slug: string,
    callerUserId: string | null,
  ): Promise<string> {
    const video = await this.loadVisibleBySlug(slug, callerUserId);
    if (video.status !== 'ready') throw new VideoNotReadyException();
    const ext = pickExtension(video.metadata);
    const sanitized = video.title.replace(/["\r\n]/g, '').slice(0, 100);
    return this.storage.signGetObjectUrl({
      bucket: this.storageCfg.bucketVideosRaw,
      key: video.raw_object_key,
      expiresInSeconds: this.storageCfg.presignDownloadTtlSeconds,
      responseContentDisposition: `attachment; filename="${sanitized}.${ext}"`,
    });
  }

  private async loadVisibleBySlug(
    slug: string,
    callerUserId: string | null,
  ): Promise<Video> {
    const video = await this.videoRepo.findOne({
      where: { public_slug: slug },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    if (video.status !== 'ready') {
      // Non-ready videos are only visible to the channel owner.
      if (!callerUserId || callerUserId !== video.channel.user_id) {
        throw new VideoNotFoundException();
      }
    }
    return video;
  }
}
