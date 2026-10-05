import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  // Phase 03 — Object Storage (MinIO)
  MINIO_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  MINIO_REGION: Joi.string().default('us-east-1'),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  BUCKET_VIDEOS_RAW: Joi.string().default('videos-raw'),
  BUCKET_VIDEOS_PROCESSED: Joi.string().default('videos-processed'),
  BUCKET_THUMBNAILS: Joi.string().default('thumbnails'),
  PRESIGN_STREAM_TTL_SECONDS: Joi.number().positive().default(900),
  PRESIGN_DOWNLOAD_TTL_SECONDS: Joi.number().positive().default(3600),
  // Phase 03 — Queue (Redis / BullMQ)
  REDIS_HOST: Joi.string().default('redis'),
  REDIS_PORT: Joi.number().port().default(6379),
  VIDEO_PROCESSING_QUEUE: Joi.string().default('video-processing'),
  VIDEO_PROCESSING_ATTEMPTS: Joi.number().integer().positive().default(3),
  VIDEO_PROCESSING_BACKOFF_MS: Joi.number().integer().positive().default(10000),
});
