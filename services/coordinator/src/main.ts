import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ObjectStorageService } from './storage/object-storage.service';
import { configureHttp } from './http-setup';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  await app.get(ObjectStorageService).ensureBucket();

  configureHttp(app);

  app.enableShutdownHooks();

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch((err) => {
  console.error('refusing to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
