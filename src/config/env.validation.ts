import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IsEnum, IsIn, IsNotEmpty, IsNumberString, IsOptional, IsString } from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsNumberString()
  PORT: string = '3000';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  JWT_SECRET?: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN?: string;

  // Stockage avatar Supabase : optionnel en dev/test (upload → 503 si
  // absent), mais si renseigné, le format est vérifié ci-dessous dans
  // validate() : URL https valide (hostname seul, jamais loggée avec secret).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SUPABASE_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SUPABASE_SERVICE_ROLE_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  FRONTEND_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_HOST?: string;

  @IsOptional()
  @IsString()
  SMTP_PORT?: string;

  @IsOptional()
  @IsString()
  SMTP_SECURE?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_PASS?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SMTP_FROM?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  RESEND_API_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  EMAIL_FROM?: string;

  // SasPay (Sprint SASPAY-01, fondations) : rail de paiement externe.
  // Toutes optionnelles : sans elles, le module SasPay refuse proprement
  // toute opération (isConfigured() = false) et les webhooks répondent 401.
  // Les secrets (sk_test_… / sk_live_…, secret webhook) restent backend
  // uniquement et ne sont JAMAIS exposés au frontend ni committés.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SASPAY_BASE_URL?: string;

  @IsOptional()
  @IsString()
  @IsIn(['TEST', 'LIVE'])
  SASPAY_MODE?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SASPAY_API_KEY?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SASPAY_WEBHOOK_SECRET?: string;

  // Relais payout VPS (sortie IP fixe, init payout uniquement) : optionnel.
  // Si SASPAY_PAYOUT_RELAY_URL est définie, `initializePayout()` transite
  // par le relay (secret partagé, même Idempotency-Key, sans clé SasPay).
  // Verify/webhooks/top-up restent directs (SASPAY_API_KEY conservée).
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SASPAY_PAYOUT_RELAY_URL?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  SASPAY_PAYOUT_RELAY_SECRET?: string;
}

export function validate(config: Record<string, unknown>): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }

  // En production, un secret signé stable est obligatoire : sans lui, chaque
  // redéploiement involontaire invaliderait toutes les sessions des clients.
  if (validatedConfig.NODE_ENV === Environment.Production && !validatedConfig.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production.');
  }

  // Si SUPABASE_URL est renseignée (Railway → Variables), elle doit être une
  // URL https valide type https://<ref>.supabase.co (espaces/slash final
  // tolérés). Une valeur mal formée produirait sinon un ENOTFOUND trompeur
  // au moment de l'upload. La clé n'est jamais affichée dans les erreurs.
  const rawSupabaseUrl = (validatedConfig.SUPABASE_URL ?? '').trim();
  if (rawSupabaseUrl.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(rawSupabaseUrl.replace(/\/+$/, ''));
    } catch {
      throw new Error('SUPABASE_URL must be a valid URL (https://<ref>.supabase.co).');
    }
    if (parsed.protocol !== 'https:' || !parsed.hostname) {
      throw new Error('SUPABASE_URL must be a valid https URL (https://<ref>.supabase.co).');
    }
  }

  return validatedConfig;
}