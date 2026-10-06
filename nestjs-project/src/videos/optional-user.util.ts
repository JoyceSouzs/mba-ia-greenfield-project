import type { JwtService } from '@nestjs/jwt';
import type { JwtPayload } from '../auth/auth.types';
import { BEARER_PREFIX } from '../auth/auth.constants';

export async function tryExtractUserId(
  authorizationHeader: string | undefined,
  jwtService: JwtService,
): Promise<string | null> {
  if (!authorizationHeader || !authorizationHeader.startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  try {
    const payload = await jwtService.verifyAsync<JwtPayload>(token);
    return payload.sub;
  } catch {
    return null;
  }
}
