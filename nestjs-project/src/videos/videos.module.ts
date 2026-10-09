import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoViewService } from './video-view.service';
import { VideosController } from './videos.controller';
import { VideosPlaybackController } from './videos-playback.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule,
    AuthModule,
  ],
  controllers: [VideosController, VideosPlaybackController],
  providers: [VideosService, VideoViewService],
  exports: [TypeOrmModule, VideosService],
})
export class VideosModule {}
