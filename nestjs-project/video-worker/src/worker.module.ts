import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../../src/config/database.config';
import { envValidationSchema } from '../../src/config/env.validation';
import queueConfig from '../../src/config/queue.config';
import storageConfig from '../../src/config/storage.config';
import { QueueModule } from '../../src/queue/queue.module';
import { StorageModule } from '../../src/storage/storage.module';
import { VideosModule } from '../../src/videos/videos.module';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbCfg: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbCfg.host,
        port: dbCfg.port,
        username: dbCfg.username,
        password: dbCfg.password,
        database: dbCfg.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    StorageModule,
    QueueModule,
    VideosModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
