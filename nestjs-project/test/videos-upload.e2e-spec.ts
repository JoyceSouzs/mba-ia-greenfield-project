import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Channel } from '../src/channels/entities/channel.entity';

describe('Videos Upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerAndLogin(
    email: string,
    password = 'password123',
  ): Promise<{ accessToken: string; channelId: string }> {
    const authService = app.get(AuthService);
    const mailService = (authService as unknown as { mailService: unknown })
      .mailService as {
      sendConfirmationEmail: (
        email: string,
        name: string,
        token: string,
      ) => Promise<void>;
    };
    let capturedToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e, _n, t) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken })
      .expect(204);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);
    const body = login.body as { access_token: string };

    const channelRepo = dataSource.getRepository(Channel);
    const user = await dataSource
      .getRepository('users')
      .createQueryBuilder('u')
      .where('u.email = :email', { email })
      .getOneOrFail();
    const channel = await channelRepo.findOneByOrFail({
      user_id: (user as { id: string }).id,
    });
    return { accessToken: body.access_token, channelId: channel.id };
  }

  it('POST /channels/:channelId/videos (owner) creates a video draft', async () => {
    const { accessToken, channelId } = await registerAndLogin(
      'e2e-videos-1@example.com',
    );
    const res = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'My Video' })
      .expect(201);
    const body = res.body as {
      videoId: string;
      publicSlug: string;
      uploadId: string;
      rawObjectKey: string;
      bucket: string;
    };
    expect(body.videoId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.publicSlug).toHaveLength(11);
    expect(body.uploadId).toBeTruthy();
    expect(body.bucket).toBe('videos-raw');
    expect(body.rawObjectKey).toContain(channelId);
  });

  it('POST /channels/:channelId/videos (foreign user) → 403 NOT_CHANNEL_OWNER', async () => {
    const owner = await registerAndLogin('e2e-videos-owner@example.com');
    const other = await registerAndLogin('e2e-videos-other@example.com');
    const res = await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos`)
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ title: 'Nope' })
      .expect(403);
    const body = res.body as { error: string };
    expect(body.error).toBe('NOT_CHANNEL_OWNER');
  });

  it('POST /channels/:channelId/videos (missing title) → 400 VALIDATION_ERROR', async () => {
    const { accessToken, channelId } = await registerAndLogin(
      'e2e-videos-v@example.com',
    );
    const res = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({})
      .expect(400);
    const body = res.body as { error: string };
    expect(body.error).toBe('VALIDATION_ERROR');
  });

  it('POST /videos/:videoId/parts (owner) returns URLs; strangers get 403', async () => {
    const owner = await registerAndLogin('e2e-videos-parts@example.com');
    const create = await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Parts' })
      .expect(201);
    const { videoId } = create.body as { videoId: string };

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/parts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ partNumbers: [1, 2] })
      .expect(200);
    const body = res.body as {
      parts: Array<{ partNumber: number; url: string; expiresAt: string }>;
    };
    expect(body.parts).toHaveLength(2);
    expect(body.parts[0].url).toMatch(/^https?:\/\//);

    const stranger = await registerAndLogin('e2e-videos-stranger@example.com');
    await request(app.getHttpServer())
      .post(`/videos/${videoId}/parts`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .send({ partNumbers: [1] })
      .expect(403);
  });

  it('DELETE /videos/:videoId/upload (owner) aborts a draft', async () => {
    const { accessToken, channelId } = await registerAndLogin(
      'e2e-videos-abort@example.com',
    );
    const create = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'To abort' })
      .expect(201);
    const { videoId } = create.body as { videoId: string };

    await request(app.getHttpServer())
      .delete(`/videos/${videoId}/upload`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(204);

    // After abort, requesting part urls should 404
    await request(app.getHttpServer())
      .post(`/videos/${videoId}/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumbers: [1] })
      .expect(404);
  });

  it('POST /videos/:videoId/complete without having requested parts → 409 UPLOAD_ALREADY_COMPLETED', async () => {
    const { accessToken, channelId } = await registerAndLogin(
      'e2e-videos-complete-badstate@example.com',
    );
    const create = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Still draft' })
      .expect(201);
    const { videoId } = create.body as { videoId: string };

    const res = await request(app.getHttpServer())
      .post(`/videos/${videoId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, eTag: 'x' }] })
      .expect(409);
    const body = res.body as { error: string };
    expect(body.error).toBe('UPLOAD_ALREADY_COMPLETED');
  });

  it('endpoints require authentication (401 without Bearer)', async () => {
    await request(app.getHttpServer())
      .post(`/channels/${crypto.randomUUID()}/videos`)
      .send({ title: 't' })
      .expect(401);
  });
});
