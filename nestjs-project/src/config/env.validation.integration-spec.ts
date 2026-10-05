import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

type EnvValues = {
  SWAGGER_ENABLED: string;
  MINIO_ENDPOINT: string;
  MINIO_REGION: string;
  BUCKET_VIDEOS_RAW: string;
  BUCKET_VIDEOS_PROCESSED: string;
  BUCKET_THUMBNAILS: string;
  PRESIGN_STREAM_TTL_SECONDS: number;
  PRESIGN_DOWNLOAD_TTL_SECONDS: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  VIDEO_PROCESSING_QUEUE: string;
  VIDEO_PROCESSING_ATTEMPTS: number;
  VIDEO_PROCESSING_BACKOFF_MS: number;
};

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  MINIO_ACCESS_KEY: 'minio-access',
  MINIO_SECRET_KEY: 'minio-secret',
};

const validate = (
  env: Record<string, string | undefined>,
): { value: EnvValues; error: ValidationError | undefined } => {
  const result = envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as { value: EnvValues; error: ValidationError | undefined };
  return result;
};

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — Phase 03 storage/queue vars', () => {
  it('should reject when MINIO_ACCESS_KEY is missing', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, MINIO_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('MINIO_ACCESS_KEY');
  });

  it('should reject when MINIO_SECRET_KEY is missing', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, MINIO_SECRET_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error).toBeDefined();
    expect(error!.message).toContain('MINIO_SECRET_KEY');
  });

  it('should apply storage defaults when optional vars are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.MINIO_ENDPOINT).toBe('http://minio:9000');
    expect(value.MINIO_REGION).toBe('us-east-1');
    expect(value.BUCKET_VIDEOS_RAW).toBe('videos-raw');
    expect(value.BUCKET_VIDEOS_PROCESSED).toBe('videos-processed');
    expect(value.BUCKET_THUMBNAILS).toBe('thumbnails');
    expect(value.PRESIGN_STREAM_TTL_SECONDS).toBe(900);
    expect(value.PRESIGN_DOWNLOAD_TTL_SECONDS).toBe(3600);
  });

  it('should apply queue defaults when optional vars are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.VIDEO_PROCESSING_QUEUE).toBe('video-processing');
    expect(value.VIDEO_PROCESSING_ATTEMPTS).toBe(3);
    expect(value.VIDEO_PROCESSING_BACKOFF_MS).toBe(10000);
  });

  it('should reject non-URI MINIO_ENDPOINT', () => {
    const { error } = validate({ MINIO_ENDPOINT: 'not-a-url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('MINIO_ENDPOINT');
  });

  it('should reject non-positive PRESIGN_STREAM_TTL_SECONDS', () => {
    const { error } = validate({ PRESIGN_STREAM_TTL_SECONDS: '0' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('PRESIGN_STREAM_TTL_SECONDS');
  });

  it('should reject non-integer VIDEO_PROCESSING_ATTEMPTS', () => {
    const { error } = validate({ VIDEO_PROCESSING_ATTEMPTS: '1.5' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('VIDEO_PROCESSING_ATTEMPTS');
  });
});
