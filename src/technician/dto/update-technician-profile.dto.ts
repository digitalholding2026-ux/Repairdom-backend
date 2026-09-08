import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';

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
}