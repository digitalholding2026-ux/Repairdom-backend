import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';

const MAX_SPECIALTIES = 20;

export class UpdateTechnicianProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(ALLOWED_CATEGORIES, { each: true })
  categories?: string[];

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(510)
  avatarUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  experience?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  serviceDescription?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIALTIES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  specialties?: string[];
}