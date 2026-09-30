import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import {
  AI_WARNING_JUSTIFICATION_MAX_LENGTH,
  AI_WARNING_JUSTIFICATION_MIN_LENGTH,
} from '../../ai/ai-warning.service.js';

/* IA-7 — justification d'un avertissement tarifaire par le technicien
 * propriétaire (texte libre, 10..2000 caractères, horodatée backend). */
export class JustifyWarningDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(AI_WARNING_JUSTIFICATION_MIN_LENGTH)
  @MaxLength(AI_WARNING_JUSTIFICATION_MAX_LENGTH)
  text!: string;
}
