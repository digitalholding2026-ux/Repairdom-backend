import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AGENT_MAX_HISTORY, AGENT_MAX_MESSAGE_CHARS } from '../backoffice-agent.service.js';

/* Conversation avec l'Agent Backoffice (ADMIN uniquement).
 * Historique conservé côté frontend (session) : le backend ne persiste rien. */

export class AgentHistoryItemDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(AGENT_MAX_MESSAGE_CHARS)
  content!: string;
}

export class AgentChatDto {
  @IsString()
  @MaxLength(AGENT_MAX_MESSAGE_CHARS)
  message!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(AGENT_MAX_HISTORY)
  @ValidateNested({ each: true })
  @Type(() => AgentHistoryItemDto)
  history?: AgentHistoryItemDto[];
}
