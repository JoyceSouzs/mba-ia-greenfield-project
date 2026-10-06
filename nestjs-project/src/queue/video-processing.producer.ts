import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue.constants';
import {
  VIDEO_PROCESSING_JOB,
  type VideoProcessingJobData,
} from './video-processing.job';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE_NAME)
    private readonly queue: Queue<VideoProcessingJobData>,
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async enqueue(data: VideoProcessingJobData): Promise<string> {
    const job = await this.queue.add(VIDEO_PROCESSING_JOB, data, {
      attempts: this.config.videoProcessingAttempts,
      backoff: {
        type: 'exponential',
        delay: this.config.videoProcessingBackoffMs,
      },
      removeOnComplete: 100,
      removeOnFail: 1000,
    });
    if (!job.id) {
      throw new Error('BullMQ did not return a job id');
    }
    return job.id;
  }
}
