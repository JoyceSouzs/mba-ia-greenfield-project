import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoProcessingService } from './video-processing.service';

/**
 * Worker-side slice of the videos domain: only the status transitions the
 * Video Worker needs. Kept separate from VideosModule so the worker does not
 * pull in HTTP controllers, AuthModule and, transitively, MailModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Video])],
  providers: [VideoProcessingService],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
