import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../../src/auth/entities/refresh-token.entity';
import { VerificationToken } from '../../src/auth/entities/verification-token.entity';
import { Channel } from '../../src/channels/entities/channel.entity';
import databaseConfig from '../../src/config/database.config';
import queueConfig from '../../src/config/queue.config';
import storageConfig from '../../src/config/storage.config';
import { StorageModule } from '../../src/storage/storage.module';
import { createTestDataSource } from '../../src/test/create-test-data-source';
import { User } from '../../src/users/entities/user.entity';
import { Video } from '../../src/videos/entities/video.entity';
import { VideoProcessingService } from '../../src/videos/video-processing.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Worker module composition', () => {
  it('compiles with StorageService, VideoProcessingService and VideoProcessor', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessor, VideoProcessingService],
    }).compile();

    expect(module.get(VideoProcessor)).toBeDefined();
    expect(module.get(VideoProcessingService)).toBeDefined();

    await module.close();
  }, 30000);
});
