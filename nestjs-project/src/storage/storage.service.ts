import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import type {
  AbortMultipartUploadInput,
  CompleteMultipartUploadInput,
  CompleteMultipartUploadOutput,
  CreateMultipartUploadInput,
  CreateMultipartUploadOutput,
  HeadObjectInput,
  HeadObjectOutput,
  PutObjectInput,
  SignGetObjectUrlInput,
  SignUploadPartUrlsInput,
  UploadPartUrl,
} from './storage.types';

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
      forcePathStyle: true,
    });
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async createMultipartUpload(
    input: CreateMultipartUploadInput,
  ): Promise<CreateMultipartUploadOutput> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType ?? 'application/octet-stream',
      }),
    );
    if (!response.UploadId) {
      throw new Error('MinIO did not return an UploadId');
    }
    return { uploadId: response.UploadId };
  }

  async signUploadPartUrls(
    input: SignUploadPartUrlsInput,
  ): Promise<UploadPartUrl[]> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return Promise.all(
      input.partNumbers.map(async (partNumber) => {
        const url = await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: input.expiresInSeconds },
        );
        return { partNumber, url, expiresAt };
      }),
    );
  }

  async completeMultipartUpload(
    input: CompleteMultipartUploadInput,
  ): Promise<CompleteMultipartUploadOutput> {
    const response = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            ETag: part.eTag,
            PartNumber: part.partNumber,
          })),
        },
      }),
    );
    return { location: response.Location ?? '' };
  }

  async abortMultipartUpload(input: AbortMultipartUploadInput): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
      }),
    );
  }

  async signGetObjectUrl(input: SignGetObjectUrlInput): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ResponseContentDisposition: input.responseContentDisposition,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async headObject(input: HeadObjectInput): Promise<HeadObjectOutput> {
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
      }),
    );
    return {
      contentLength: response.ContentLength ?? 0,
      contentType: response.ContentType,
    };
  }

  async putObject(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType ?? 'application/octet-stream',
      }),
    );
  }
}
