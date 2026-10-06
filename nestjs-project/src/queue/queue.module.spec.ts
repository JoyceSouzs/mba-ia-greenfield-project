import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE_NAME } from './queue.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('QueueModule', () => {
  it('compiles with VideoProcessingProducer wired to the configured queue', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const producer = module.get(VideoProcessingProducer);
    expect(producer).toBeDefined();

    const queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE_NAME));
    expect(queue).toBeDefined();
    expect(typeof queue.add).toBe('function');

    await module.close();
  }, 30000);
});
