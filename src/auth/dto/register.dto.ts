import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  firstName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsEmail()
  @MaxLength(200)
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  password: string;
}