export const VIDEO_PROCESSING_JOB = 'video.process';

export interface VideoProcessingJobData {
  videoId: string;
  channelId: string;
  rawObjectKey: string;
}

export interface VideoProcessingJobResult {
  durationSeconds: number;
  thumbnailObjectKey: string;
  metadata: Record<string, unknown>;
}
