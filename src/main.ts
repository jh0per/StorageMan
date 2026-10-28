import 'dotenv/config';
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadHttpsOptions } from './https-options';

async function bootstrap() {
  const httpsOptions = loadHttpsOptions();
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    httpsOptions ? { httpsOptions } : {},
  );
  app.enableCors({
    origin: '*',
  });
  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(`Dashboard on ${httpsOptions ? 'https' : 'http'} port ${port}`, 'Bootstrap');
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to bootstrap Nest application', error);
  process.exit(1);
});
