import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^(\+?[0-9 ().-]{7,19})?$/, {
    message: 'Numéro de téléphone invalide (chiffres, espaces, +, parenthèses ou tirets).',
  })
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  @Matches(/^(\+?[0-9 ().-]{7,19})?$/, {
    message: 'Numéro WhatsApp invalide (chiffres, espaces, +, parenthèses ou tirets).',
  })
  whatsapp?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string | null;
}