export interface CreateMultipartUploadInput {
  bucket: string;
  key: string;
  contentType?: string;
}

export interface CreateMultipartUploadOutput {
  uploadId: string;
}

export interface SignUploadPartUrlsInput {
  bucket: string;
  key: string;
  uploadId: string;
  partNumbers: number[];
  expiresInSeconds: number;
}

export interface UploadPartUrl {
  partNumber: number;
  url: string;
  expiresAt: Date;
}

export interface CompletedPart {
  partNumber: number;
  eTag: string;
}

export interface CompleteMultipartUploadInput {
  bucket: string;
  key: string;
  uploadId: string;
  parts: CompletedPart[];
}

export interface CompleteMultipartUploadOutput {
  location: string;
}

export interface AbortMultipartUploadInput {
  bucket: string;
  key: string;
  uploadId: string;
}

export interface SignGetObjectUrlInput {
  bucket: string;
  key: string;
  expiresInSeconds: number;
  responseContentDisposition?: string;
}

export interface HeadObjectInput {
  bucket: string;
  key: string;
}

export interface HeadObjectOutput {
  contentLength: number;
  contentType?: string;
}

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: Buffer | Uint8Array;
  contentType?: string;
}
