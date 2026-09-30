import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AI_AGENT_MAX_HISTORY, AI_AGENT_MAX_MESSAGE_CHARS } from '../../ai/ai-admin-agent.service.js';

/* IA-11 — question à l'Agent IA admin (ADMIN uniquement). Historique =
 * session frontend, borné et validé (jamais persisté côté backend). */

export class AiAgentHistoryItemDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_AGENT_MAX_MESSAGE_CHARS * 2)
  content!: string;
}

export class AiAgentChatDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_AGENT_MAX_MESSAGE_CHARS)
  message!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AI_AGENT_MAX_HISTORY)
  @ValidateNested({ each: true })
  @Type(() => AiAgentHistoryItemDto)
  history?: AiAgentHistoryItemDto[];
}
