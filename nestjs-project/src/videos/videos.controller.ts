import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { RequestPartUrlsDto } from './dto/request-part-urls.dto';
import type { UploadPartUrl } from '../storage/storage.types';
import { VideosService, type CreateVideoOutput } from './videos.service';

@ApiTags('videos')
@ApiBearerAuth()
@Controller()
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('channels/:channelId/videos')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a video draft and initiate multipart upload',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 403, type: ApiErrorEnvelope })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  async createVideo(
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() dto: CreateVideoDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<CreateVideoOutput> {
    return this.videosService.createVideo({
      channelId,
      userId: user.sub,
      title: dto.title,
      contentType: dto.contentType,
    });
  }

  @Post('videos/:videoId/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request presigned URLs for a batch of upload parts',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 403, type: ApiErrorEnvelope })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async requestPartUrls(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: RequestPartUrlsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ parts: UploadPartUrl[] }> {
    const parts = await this.videosService.requestPartUrls({
      videoId,
      userId: user.sub,
      partNumbers: dto.partNumbers,
    });
    return { parts };
  }

  @Post('videos/:videoId/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Complete the multipart upload and enqueue processing',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, type: ApiErrorEnvelope })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async completeUpload(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.videosService.completeUpload({
      videoId,
      userId: user.sub,
      parts: dto.parts,
    });
  }

  @Delete('videos/:videoId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Abort an in-flight upload and discard the draft' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403, type: ApiErrorEnvelope })
  @ApiResponse({ status: 404, type: ApiErrorEnvelope })
  @ApiResponse({ status: 409, type: ApiErrorEnvelope })
  async abortUpload(
    @Param('videoId', ParseUUIDPipe) videoId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.videosService.abortUpload({
      videoId,
      userId: user.sub,
    });
  }
}
