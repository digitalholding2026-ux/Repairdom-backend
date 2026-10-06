import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Décision administrative sur un signalement anti-fraude du programme de
 * récompenses (chantier #4A).
 *
 * `decision` est contrainte à `VALIDATED | REJECTED` : le service revalide
 * aussi, mais le DTO garantit qu'une valeur arbitraire n'atteint jamais la
 * base. `note` est un commentaire libre borné à 500 caractères, jamais
 * affiché tel quel au client.
 */
export class ResolveRewardFraudDto {
  @IsIn(['VALIDATED', 'REJECTED'])
  decision: 'VALIDATED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
