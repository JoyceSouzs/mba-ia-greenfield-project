import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

const BUCKET = process.env.BUCKET_VIDEOS_RAW ?? 'videos-raw';

describe('StorageService (integration — real MinIO)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    service = module.get(StorageService);
  });

  afterAll(() => {
    service.onModuleDestroy();
  });

  async function putPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    if (!response.ok) {
      throw new Error(
        `PUT part failed: ${response.status} ${await response.text()}`,
      );
    }
    const etag = response.headers.get('etag');
    if (!etag) {
      throw new Error('MinIO did not return an ETag');
    }
    return etag;
  }

  it('performs a full multipart upload end-to-end against MinIO', async () => {
    const key = `integration/${randomUUID()}/raw`;
    const { uploadId } = await service.createMultipartUpload({
      bucket: BUCKET,
      key,
      contentType: 'application/octet-stream',
    });
    expect(uploadId).toBeTruthy();

    // S3 enforces a 5MiB minimum per part except the last — use a 6MiB
    // buffer for part 1 and a tail buffer for part 2.
    const part1 = Buffer.alloc(6 * 1024 * 1024, 0xab);
    const part2 = Buffer.alloc(1024, 0xcd);

    const [url1, url2] = await service.signUploadPartUrls({
      bucket: BUCKET,
      key,
      uploadId,
      partNumbers: [1, 2],
      expiresInSeconds: 300,
    });
    expect(url1.partNumber).toBe(1);
    expect(url2.partNumber).toBe(2);

    const etag1 = await putPart(url1.url, part1);
    const etag2 = await putPart(url2.url, part2);

    const complete = await service.completeMultipartUpload({
      bucket: BUCKET,
      key,
      uploadId,
      parts: [
        { partNumber: 1, eTag: etag1 },
        { partNumber: 2, eTag: etag2 },
      ],
    });
    expect(complete.location).toBeTruthy();

    const head = await service.headObject({ bucket: BUCKET, key });
    expect(head.contentLength).toBe(part1.length + part2.length);
  }, 60000);

  it('yields a signed GET URL that returns 206 Partial Content for a Range request', async () => {
    const key = `integration/${randomUUID()}/raw`;
    const payload = Buffer.alloc(10 * 1024 * 1024, 0x55); // 10 MiB
    // single-part via multipart to exercise the same flow
    const { uploadId } = await service.createMultipartUpload({
      bucket: BUCKET,
      key,
    });
    const [{ url: partUrl }] = await service.signUploadPartUrls({
      bucket: BUCKET,
      key,
      uploadId,
      partNumbers: [1],
      expiresInSeconds: 300,
    });
    const etag = await putPart(partUrl, payload);
    await service.completeMultipartUpload({
      bucket: BUCKET,
      key,
      uploadId,
      parts: [{ partNumber: 1, eTag: etag }],
    });

    const getUrl = await service.signGetObjectUrl({
      bucket: BUCKET,
      key,
      expiresInSeconds: 300,
    });
    const response = await fetch(getUrl, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(response.status).toBe(206);
    const contentRange = response.headers.get('content-range');
    expect(contentRange).toMatch(/^bytes 0-1023\/\d+/);
    const buf = Buffer.from(await response.arrayBuffer());
    expect(buf.length).toBe(1024);
  }, 60000);

  it('aborts a multipart upload cleanly', async () => {
    const key = `integration/${randomUUID()}/raw`;
    const { uploadId } = await service.createMultipartUpload({
      bucket: BUCKET,
      key,
    });
    await expect(
      service.abortMultipartUpload({ bucket: BUCKET, key, uploadId }),
    ).resolves.toBeUndefined();

    // After abort, completing with the same uploadId should fail.
    await expect(
      service.completeMultipartUpload({
        bucket: BUCKET,
        key,
        uploadId,
        parts: [{ partNumber: 1, eTag: '"nope"' }],
      }),
    ).rejects.toThrow();
  }, 30000);

  it('put + head round-trip for a small thumbnail', async () => {
    const key = `integration/${randomUUID()}/thumb.jpg`;
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG header-ish
    await service.putObject({
      bucket: process.env.BUCKET_THUMBNAILS ?? 'thumbnails',
      key,
      body,
      contentType: 'image/jpeg',
    });
    const head = await service.headObject({
      bucket: process.env.BUCKET_THUMBNAILS ?? 'thumbnails',
      key,
    });
    expect(head.contentLength).toBe(body.length);
    expect(head.contentType).toBe('image/jpeg');
  }, 30000);
});
