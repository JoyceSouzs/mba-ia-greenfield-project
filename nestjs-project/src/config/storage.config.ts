import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
  region: process.env.MINIO_REGION || 'us-east-1',
  accessKey: process.env.MINIO_ACCESS_KEY || 'streamtube',
  secretKey: process.env.MINIO_SECRET_KEY || 'streamtube-secret',
  bucketVideosRaw: process.env.BUCKET_VIDEOS_RAW || 'videos-raw',
  bucketVideosProcessed:
    process.env.BUCKET_VIDEOS_PROCESSED || 'videos-processed',
  bucketThumbnails: process.env.BUCKET_THUMBNAILS || 'thumbnails',
  presignStreamTtlSeconds: parseInt(
    process.env.PRESIGN_STREAM_TTL_SECONDS || '900',
    10,
  ),
  presignDownloadTtlSeconds: parseInt(
    process.env.PRESIGN_DOWNLOAD_TTL_SECONDS || '3600',
    10,
  ),
}));
