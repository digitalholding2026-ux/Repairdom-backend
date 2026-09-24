import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { HttpExceptionFilter } from './common/filters/http-exception.filter.js';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // Sprint SASPAY-03 : `rawBody: true` conserve les octets exacts de chaque
  // requête (req.rawBody) — indispensable au webhook SasPay dont la signature
  // HMAC couvre `${timestamp}.${rawBody}` au bit près. Sans le corps brut
  // exact, la vérification est refusée (aucun fallback re-sérialisé).
  const app = await NestFactory.create(AppModule, { rawBody: true });
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

  // En production, l'accès cross-origin doit être restreint aux origines
  // explicites (frontend Vercel). Sans elles, le démarrage échoue plutôt que
  // d'ouvrir implicitement l'API à toutes les origines.
  const isProduction = config.get<string>('NODE_ENV') === 'production';
  if (isProduction && (!corsOrigins || corsOrigins.length === 0)) {
    throw new Error('CORS_ORIGINS is required in production (comma-separated list of allowed origins).');
  }

  app.enableCors({
    // `origin: true` reflète l'origine appelante ; les cookies HttpOnly sont
    // transmis avec `credentials: true`. Uniquement hors production.
    origin: corsOrigins?.length ? corsOrigins : true,
    credentials: true,
  });

  const port = Number(config.get<string>('PORT')) || 3000;
  await app.listen(port);
}
await bootstrap();