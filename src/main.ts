import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.use(cookieParser());

  const corsOrigins = config.get<string>('CORS_ORIGINS')
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    // `origin: true` reflète l'origine appelante ; les cookies HttpOnly sont
    // transmis avec `credentials: true`.
    origin: corsOrigins?.length ? corsOrigins : true,
    credentials: true,
  });

  const port = Number(config.get<string>('PORT')) || 3000;
  await app.listen(port);
}
await bootstrap();