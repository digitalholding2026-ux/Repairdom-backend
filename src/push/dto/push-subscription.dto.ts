import { IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class PushKeysDto {
  @IsString()
  @IsNotEmpty()
  p256dh!: string;

  @IsString()
  @IsNotEmpty()
  auth!: string;
}

class PushSubscriptionObjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  endpoint!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;
}

export class RegisterPushSubscriptionDto {
  @IsObject()
  @ValidateNested()
  @Type(() => PushSubscriptionObjectDto)
  subscription!: PushSubscriptionObjectDto;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  userAgent?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  deviceLabel?: string;
}

export class UnregisterPushSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  endpoint!: string;
}
