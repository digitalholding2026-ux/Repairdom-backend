import { IsIn } from 'class-validator';
import { DEMANDE_STATUSES, type DemandeLifecycleStatus } from '../demandes-lifecycle.js';

export class UpdateDemandeStatusDto {
  @IsIn(DEMANDE_STATUSES)
  status: DemandeLifecycleStatus;
}