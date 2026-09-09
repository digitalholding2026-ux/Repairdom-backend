import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateKycStatusDto {
  @IsIn(['VERIFIED', 'REJECTED'])
  status: 'VERIFIED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}