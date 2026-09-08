import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export const MESSAGE_MAX_LENGTH = 2000;

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(MESSAGE_MAX_LENGTH)
  content: string;
}