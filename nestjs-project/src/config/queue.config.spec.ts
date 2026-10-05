import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const QUEUE_KEYS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'VIDEO_PROCESSING_QUEUE',
  'VIDEO_PROCESSING_ATTEMPTS',
  'VIDEO_PROCESSING_BACKOFF_MS',
] as const;

const loadConfig = async (
  overrides: Partial<Record<(typeof QUEUE_KEYS)[number], string>> = {},
): Promise<ConfigType<typeof queueConfig>> => {
  for (const key of QUEUE_KEYS) {
    if (overrides[key] !== undefined) {
      process.env[key] = overrides[key];
    } else {
      delete process.env[key];
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
    ],
  }).compile();
  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return config;
};

describe('queueConfig', () => {
  afterEach(() => {
    for (const key of QUEUE_KEYS) {
      delete process.env[key];
    }
  });

  it('returns defaults when no queue env vars are set', async () => {
    const config = await loadConfig();
    expect(config).toEqual({
      redisHost: 'redis',
      redisPort: 6379,
      videoProcessingQueue: 'video-processing',
      videoProcessingAttempts: 3,
      videoProcessingBackoffMs: 10000,
    });
  });

  it('reads overrides from the environment', async () => {
    const config = await loadConfig({
      REDIS_HOST: 'cache',
      REDIS_PORT: '6380',
      VIDEO_PROCESSING_QUEUE: 'custom-queue',
      VIDEO_PROCESSING_ATTEMPTS: '5',
      VIDEO_PROCESSING_BACKOFF_MS: '20000',
    });
    expect(config.redisHost).toBe('cache');
    expect(config.redisPort).toBe(6380);
    expect(config.videoProcessingQueue).toBe('custom-queue');
    expect(config.videoProcessingAttempts).toBe(5);
    expect(config.videoProcessingBackoffMs).toBe(20000);
  });

  it('parses numeric env vars as integers', async () => {
    const config = await loadConfig({
      REDIS_PORT: '7777',
      VIDEO_PROCESSING_ATTEMPTS: '7',
      VIDEO_PROCESSING_BACKOFF_MS: '2500',
    });
    expect(typeof config.redisPort).toBe('number');
    expect(config.redisPort).toBe(7777);
    expect(typeof config.videoProcessingAttempts).toBe('number');
    expect(config.videoProcessingAttempts).toBe(7);
    expect(typeof config.videoProcessingBackoffMs).toBe('number');
    expect(config.videoProcessingBackoffMs).toBe(2500);
  });
});
