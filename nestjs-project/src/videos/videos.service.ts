import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { VideoProcessingProducer } from '../queue/video-processing.producer';
import { StorageService } from '../storage/storage.service';
import type { UploadPartUrl } from '../storage/storage.types';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import { Video } from './entities/video.entity';
import {
  ChannelNotFoundException,
  InvalidStatusTransitionException,
  NotChannelOwnerException,
  SlugGenerationFailedException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
} from './exceptions/videos.exceptions';
import { generatePublicSlug } from './slug.generator';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_SLUG_COLUMN = 'public_slug';
const MAX_SLUG_RETRIES = 5;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

export interface CreateVideoInput {
  channelId: string;
  userId: string;
  title: string;
  contentType?: string;
}

export interface CreateVideoOutput {
  videoId: string;
  publicSlug: string;
  uploadId: string;
  rawObjectKey: string;
  bucket: string;
}

export interface RequestPartUrlsInput {
  videoId: string;
  userId: string;
  partNumbers: number[];
}

export interface CompleteUploadInput {
  videoId: string;
  userId: string;
  parts: CompletedPartDto[];
}

export interface AbortUploadInput {
  videoId: string;
  userId: string;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video) private readonly videoRepo: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepo: Repository<Channel>,
    private readonly storage: StorageService,
    private readonly producer: VideoProcessingProducer,
    @Inject(storageConfig.KEY)
    private readonly storageCfg: ConfigType<typeof storageConfig>,
  ) {}

  async createVideo(input: CreateVideoInput): Promise<CreateVideoOutput> {
    const channel = await this.channelRepo.findOne({
      where: { id: input.channelId },
    });
    if (!channel) throw new ChannelNotFoundException();
    if (channel.user_id !== input.userId) {
      throw new NotChannelOwnerException();
    }

    const videoId = crypto.randomUUID();
    const bucket = this.storageCfg.bucketVideosRaw;
    const rawObjectKey = `${input.channelId}/${videoId}/raw`;

    const { uploadId } = await this.storage.createMultipartUpload({
      bucket,
      key: rawObjectKey,
      contentType: input.contentType,
    });

    const publicSlug = await this.saveDraftWithUniqueSlug({
      id: videoId,
      channelId: input.channelId,
      title: input.title,
      rawObjectKey,
      uploadId,
    });

    this.logger.log(
      `Created draft video=${videoId} slug=${publicSlug} channel=${input.channelId}`,
    );
    return { videoId, publicSlug, uploadId, rawObjectKey, bucket };
  }

  async requestPartUrls(input: RequestPartUrlsInput): Promise<UploadPartUrl[]> {
    const video = await this.loadOwnedVideo(input.videoId, input.userId);
    if (video.status !== 'draft' && video.status !== 'uploading') {
      throw new InvalidStatusTransitionException();
    }
    if (!video.multipart_upload_id) {
      throw new InvalidStatusTransitionException();
    }

    const urls = await this.storage.signUploadPartUrls({
      bucket: this.storageCfg.bucketVideosRaw,
      key: video.raw_object_key,
      uploadId: video.multipart_upload_id,
      partNumbers: input.partNumbers,
      expiresInSeconds: this.storageCfg.presignStreamTtlSeconds,
    });

    if (video.status === 'draft') {
      await this.videoRepo.update({ id: video.id }, { status: 'uploading' });
    }
    return urls;
  }

  async completeUpload(input: CompleteUploadInput): Promise<void> {
    const video = await this.loadOwnedVideo(input.videoId, input.userId);
    if (video.status !== 'uploading') {
      throw new UploadAlreadyCompletedException();
    }
    if (!video.multipart_upload_id) {
      throw new UploadAlreadyCompletedException();
    }

    await this.storage.completeMultipartUpload({
      bucket: this.storageCfg.bucketVideosRaw,
      key: video.raw_object_key,
      uploadId: video.multipart_upload_id,
      parts: input.parts,
    });

    await this.videoRepo.update(
      { id: video.id },
      { status: 'processing', multipart_upload_id: null },
    );

    await this.producer.enqueue({
      videoId: video.id,
      channelId: video.channel_id,
      rawObjectKey: video.raw_object_key,
    });
    this.logger.log(
      `Completed upload for video=${video.id}, transitioned to processing`,
    );
  }

  async abortUpload(input: AbortUploadInput): Promise<void> {
    const video = await this.loadOwnedVideo(input.videoId, input.userId);
    if (video.status !== 'draft' && video.status !== 'uploading') {
      throw new InvalidStatusTransitionException();
    }

    if (video.multipart_upload_id) {
      await this.storage.abortMultipartUpload({
        bucket: this.storageCfg.bucketVideosRaw,
        key: video.raw_object_key,
        uploadId: video.multipart_upload_id,
      });
    }

    await this.videoRepo.delete({ id: video.id });
    this.logger.log(`Aborted video=${video.id}, draft removed`);
  }

  private async loadOwnedVideo(
    videoId: string,
    userId: string,
  ): Promise<Video & { channel: Channel }> {
    const video = await this.videoRepo.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel.user_id !== userId) {
      throw new NotChannelOwnerException();
    }
    return video as Video & { channel: Channel };
  }

  private async saveDraftWithUniqueSlug(opts: {
    id: string;
    channelId: string;
    title: string;
    rawObjectKey: string;
    uploadId: string;
  }): Promise<string> {
    for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
      const slug = generatePublicSlug();
      try {
        await this.videoRepo.insert({
          id: opts.id,
          channel_id: opts.channelId,
          title: opts.title,
          status: 'draft',
          public_slug: slug,
          raw_object_key: opts.rawObjectKey,
          multipart_upload_id: opts.uploadId,
        });
        return slug;
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, PUBLIC_SLUG_COLUMN)) {
          throw err;
        }
      }
    }
    throw new SlugGenerationFailedException();
  }
}
