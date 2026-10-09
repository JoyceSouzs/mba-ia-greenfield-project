import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppModule } from '../app.module';
import { VideoViewService } from './video-view.service';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('resolves VideosService + VideoViewService inside AppModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(moduleRef.get(VideosService)).toBeDefined();
    expect(moduleRef.get(VideoViewService)).toBeDefined();

    await moduleRef.close();
  }, 30000);

  // Guard import so the ConfigModule reference stays live even if the first
  // test is deleted — the module composition still requires it transitively.
  it('imports resolve', () => {
    expect(ConfigModule).toBeDefined();
    expect(TypeOrmModule).toBeDefined();
  });
});
