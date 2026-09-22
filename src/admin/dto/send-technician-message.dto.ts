import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/* Message direct ADMIN → TECHNICIEN. Le destinataire est identifié par son
 * adresse email (normalisée côté backend) ; aucun userId arbitraire du
 * frontend n'est accepté comme référence. */
export class SendTechnicianMessageDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  message: string;
}
