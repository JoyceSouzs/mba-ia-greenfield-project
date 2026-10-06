import { nanoid } from 'nanoid';

export const SLUG_LENGTH = 11;

export function generatePublicSlug(length: number = SLUG_LENGTH): string {
  return nanoid(length);
}
