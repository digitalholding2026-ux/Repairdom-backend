import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const MEDIA_KINDS = ['IMAGE', 'VIDEO', 'AUDIO'] as const;
export const MAX_MEDIA_FILES = 5;
export const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024;

export class RequestMediaDto {
  @IsIn(MEDIA_KINDS)
  kind: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_MEDIA_SIZE_BYTES)
  sizeBytes: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  storagePath?: string;
}

export class CreateDemandeDto {
  @IsString()
  @IsNotEmpty()
  serviceCode: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  catalogItemId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  discountCode?: string;
}
