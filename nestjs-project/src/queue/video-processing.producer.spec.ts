import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue.constants';
import { VIDEO_PROCESSING_JOB } from './video-processing.job';
import { VideoProcessingProducer } from './video-processing.producer';

const TEST_QUEUE_CONFIG = {
  redisHost: 'redis',
  redisPort: 6379,
  videoProcessingQueue: VIDEO_PROCESSING_QUEUE_NAME,
  videoProcessingAttempts: 3,
  videoProcessingBackoffMs: 10000,
};

describe('VideoProcessingProducer (unit)', () => {
  let producer: VideoProcessingProducer;
  let addMock: jest.Mock;

  beforeEach(async () => {
    addMock = jest.fn();
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProducer,
        { provide: queueConfig.KEY, useValue: TEST_QUEUE_CONFIG },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE_NAME),
          useValue: { add: addMock },
        },
      ],
    }).compile();
    producer = module.get(VideoProcessingProducer);
  });

  it('calls queue.add with job name, payload and options derived from config', async () => {
    addMock.mockResolvedValue({ id: 'job-1' });

    const jobId = await producer.enqueue({
      videoId: 'vid',
      channelId: 'ch',
      rawObjectKey: 'ch/vid/raw',
    });

    expect(jobId).toBe('job-1');
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      VIDEO_PROCESSING_JOB,
      { videoId: 'vid', channelId: 'ch', rawObjectKey: 'ch/vid/raw' },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    );
  });

  it('throws when BullMQ returns a job without an id', async () => {
    addMock.mockResolvedValue({ id: undefined });
    await expect(
      producer.enqueue({ videoId: 'v', channelId: 'c', rawObjectKey: 'k' }),
    ).rejects.toThrow('BullMQ did not return a job id');
  });
});
