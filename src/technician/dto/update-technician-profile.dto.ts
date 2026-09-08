import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';

export class UpdateTechnicianProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city: string;

  @IsArray()
  @IsString({ each: true })
  @IsIn(ALLOWED_CATEGORIES, { each: true })
  categories: string[];
}