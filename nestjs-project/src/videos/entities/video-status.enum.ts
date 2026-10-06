export const VIDEO_STATUS_VALUES = [
  'draft',
  'uploading',
  'processing',
  'ready',
  'failed',
] as const;

export type VideoStatus = (typeof VIDEO_STATUS_VALUES)[number];
