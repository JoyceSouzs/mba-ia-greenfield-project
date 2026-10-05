import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const STORAGE_KEYS = [
  'MINIO_ENDPOINT',
  'MINIO_REGION',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
  'BUCKET_VIDEOS_RAW',
  'BUCKET_VIDEOS_PROCESSED',
  'BUCKET_THUMBNAILS',
  'PRESIGN_STREAM_TTL_SECONDS',
  'PRESIGN_DOWNLOAD_TTL_SECONDS',
] as const;

const loadConfig = async (
  overrides: Partial<Record<(typeof STORAGE_KEYS)[number], string>> = {},
): Promise<ConfigType<typeof storageConfig>> => {
  for (const key of STORAGE_KEYS) {
    if (overrides[key] !== undefined) {
      process.env[key] = overrides[key];
    } else {
      delete process.env[key];
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();
  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  afterEach(() => {
    for (const key of STORAGE_KEYS) {
      delete process.env[key];
    }
  });

  it('returns defaults when no storage env vars are set', async () => {
    const config = await loadConfig();
    expect(config).toEqual({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      accessKey: 'streamtube',
      secretKey: 'streamtube-secret',
      bucketVideosRaw: 'videos-raw',
      bucketVideosProcessed: 'videos-processed',
      bucketThumbnails: 'thumbnails',
      presignStreamTtlSeconds: 900,
      presignDownloadTtlSeconds: 3600,
    });
  });

  it('reads overrides from the environment', async () => {
    const config = await loadConfig({
      MINIO_ENDPOINT: 'http://custom:9000',
      MINIO_REGION: 'sa-east-1',
      MINIO_ACCESS_KEY: 'alice',
      MINIO_SECRET_KEY: 'alice-secret',
      BUCKET_VIDEOS_RAW: 'raw',
      BUCKET_VIDEOS_PROCESSED: 'proc',
      BUCKET_THUMBNAILS: 'thumbs',
      PRESIGN_STREAM_TTL_SECONDS: '600',
      PRESIGN_DOWNLOAD_TTL_SECONDS: '7200',
    });
    expect(config.endpoint).toBe('http://custom:9000');
    expect(config.region).toBe('sa-east-1');
    expect(config.accessKey).toBe('alice');
    expect(config.secretKey).toBe('alice-secret');
    expect(config.bucketVideosRaw).toBe('raw');
    expect(config.bucketVideosProcessed).toBe('proc');
    expect(config.bucketThumbnails).toBe('thumbs');
    expect(config.presignStreamTtlSeconds).toBe(600);
    expect(config.presignDownloadTtlSeconds).toBe(7200);
  });

  it('parses TTL env vars as integers', async () => {
    const config = await loadConfig({
      PRESIGN_STREAM_TTL_SECONDS: '42',
      PRESIGN_DOWNLOAD_TTL_SECONDS: '1337',
    });
    expect(typeof config.presignStreamTtlSeconds).toBe('number');
    expect(config.presignStreamTtlSeconds).toBe(42);
    expect(typeof config.presignDownloadTtlSeconds).toBe('number');
    expect(config.presignDownloadTtlSeconds).toBe(1337);
  });
});
