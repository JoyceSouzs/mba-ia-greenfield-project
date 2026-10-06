import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue, Worker, type Job } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue.constants';
import {
  VIDEO_PROCESSING_JOB,
  type VideoProcessingJobData,
} from './video-processing.job';
import { VideoProcessingProducer } from './video-processing.producer';

const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT ?? 6379),
  maxRetriesPerRequest: null,
};

describe('VideoProcessingProducer (integration — real Redis)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let drainQueue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();
    producer = moduleRef.get(VideoProcessingProducer);

    // Drain any pre-existing jobs AND events from previous runs.
    drainQueue = new Queue(VIDEO_PROCESSING_QUEUE_NAME, {
      connection: REDIS_CONNECTION,
    });
    await drainQueue.drain(true);
    await drainQueue.clean(0, 1000, 'completed');
    await drainQueue.clean(0, 1000, 'failed');
    await drainQueue.clean(0, 1000, 'wait');
    await drainQueue.clean(0, 1000, 'active');
    await drainQueue.clean(0, 1000, 'delayed');
    await drainQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await drainQueue.obliterate({ force: true }).catch(() => undefined);
    await drainQueue.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await drainQueue.obliterate({ force: true }).catch(() => undefined);
  });

  it('enqueues a job and a scoped worker on the same queue consumes it', async () => {
    const payload: VideoProcessingJobData = {
      videoId: '11111111-1111-1111-1111-111111111111',
      channelId: '22222222-2222-2222-2222-222222222222',
      rawObjectKey: '22222222/11111111/raw',
    };

    const received = new Promise<Job<VideoProcessingJobData>>((resolve) => {
      const worker = new Worker<VideoProcessingJobData>(
        VIDEO_PROCESSING_QUEUE_NAME,
        async (job) => {
          resolve(job);
          await worker.close();
          return;
        },
        { connection: REDIS_CONNECTION },
      );
    });

    const jobId = await producer.enqueue(payload);
    expect(jobId).toBeTruthy();

    const job = await received;
    expect(job.id).toBe(jobId);
    expect(job.name).toBe(VIDEO_PROCESSING_JOB);
    expect(job.data).toEqual(payload);
    // Options round-trip
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({
      type: 'exponential',
      delay: 10000,
    });
  }, 30000);
});
