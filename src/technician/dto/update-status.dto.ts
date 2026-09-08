import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { DEMANDE_STATUSES, type DemandeLifecycleStatus } from '../../demandes/demandes-lifecycle.js';

export class TechnicianUpdateStatusDto {
  @IsIn(DEMANDE_STATUSES)
  status: DemandeLifecycleStatus;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  scheduledAt?: string;
}