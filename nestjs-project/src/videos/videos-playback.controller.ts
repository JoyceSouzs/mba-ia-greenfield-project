import {
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Redirect,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { tryExtractUserId } from './optional-user.util';
import { VideoViewService, type VideoMetadata } from './video-view.service';

@ApiTags('videos')
@Controller('videos')
export class VideosPlaybackController {
  constructor(
    private readonly viewService: VideoViewService,
    private readonly jwtService: JwtService,
  ) {}

  @Public()
  @Get(':slug')
  @ApiOperation({
    summary: 'Fetch public video metadata',
    description:
      'Returns the metadata envelope for a `ready` video. Non-ready videos are only visible to the channel owner; strangers get 404.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async getMetadata(
    @Param('slug') slug: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<VideoMetadata> {
    const userId = await tryExtractUserId(authorization, this.jwtService);
    return this.viewService.getMetadata(slug, userId);
  }

  @Public()
  @Get(':slug/stream')
  @Redirect(undefined, HttpStatus.TEMPORARY_REDIRECT)
  @ApiOperation({
    summary: 'Redirect to a presigned stream URL (15 min TTL)',
    description:
      'Responds 307 with a presigned GET URL from MinIO. The client follows the redirect; MinIO honours HTTP Range requests with 206 Partial Content.',
  })
  @ApiResponse({ status: 307 })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async stream(
    @Param('slug') slug: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const userId = await tryExtractUserId(authorization, this.jwtService);
    const url = await this.viewService.getStreamUrl(slug, userId);
    return { url, statusCode: HttpStatus.TEMPORARY_REDIRECT };
  }

  @Public()
  @Get(':slug/download')
  @Redirect(undefined, HttpStatus.TEMPORARY_REDIRECT)
  @ApiOperation({
    summary: 'Redirect to a presigned download URL (1 h TTL)',
    description:
      'Responds 307 with a presigned GET URL from MinIO; the URL embeds `response-content-disposition=attachment; filename="…"` so the browser saves the file instead of playing it.',
  })
  @ApiResponse({ status: 307 })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async download(
    @Param('slug') slug: string,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<{ url: string; statusCode: number }> {
    const userId = await tryExtractUserId(authorization, this.jwtService);
    const url = await this.viewService.getDownloadUrl(slug, userId);
    return { url, statusCode: HttpStatus.TEMPORARY_REDIRECT };
  }
}
