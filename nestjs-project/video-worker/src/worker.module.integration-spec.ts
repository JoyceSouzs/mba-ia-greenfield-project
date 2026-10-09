import { Test } from '@nestjs/testing';
import { StorageService } from '../../src/storage/storage.service';
import { VideoProcessingService } from '../../src/videos/video-processing.service';
import { VideoProcessor } from './video.processor';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  // Compiles the real WorkerModule (same as main.ts) so any transitive import
  // requiring config the worker does not load (e.g. MAILER_OPTIONS) fails here.
  it('compiles and resolves VideoProcessor with its dependencies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(moduleRef.get(VideoProcessor)).toBeDefined();
    expect(moduleRef.get(VideoProcessingService)).toBeDefined();
    expect(moduleRef.get(StorageService)).toBeDefined();

    await moduleRef.close();
  }, 30000);
});
