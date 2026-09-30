import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/* IA-8 — revue humaine d'un signal conversationnel (décision conservée,
 * signal jamais supprimé, jamais de sanction automatique). */
export class ReviewConversationFlagDto {
  @IsIn(['REVIEWED', 'DISMISSED'])
  decision!: 'REVIEWED' | 'DISMISSED';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}
