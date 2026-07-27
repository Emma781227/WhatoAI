import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token opaque reçu par email' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  token!: string;
}
