import { INestApplication, ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { applyCors } from './anchor/anchor-cors';
import { AppConfigService } from './config/app-config.service';

export function configureHttp(app: INestApplication): void {
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(helmet());
  applyCors(app, app.get(AppConfigService).corsOrigins);
  app.use(require('express').json({ limit: '100kb' }));
  app.use(require('express').urlencoded({ extended: false, limit: '100kb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
}
