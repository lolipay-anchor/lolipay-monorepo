import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ObjectStorageService } from './storage/object-storage.service';
import { AppConfigService } from './config/app-config.service';
import cors from 'cors';
import { anchorCorsOptions } from './anchor/anchor-cors';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  await app.get(ObjectStorageService).ensureBucket();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(helmet());

  app.enableShutdownHooks();

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // @ts-ignore
  app.use(require('express').json({ limit: '100kb' }));
  app.use(require('express').urlencoded({ extended: false, limit: '100kb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const corsOrigins = app.get(AppConfigService).corsOrigins;
  app.use(
    cors((req, done) =>
      done(null, anchorCorsOptions((req as unknown as { path: string }).path, corsOrigins)),
    ),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error('refusing to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
