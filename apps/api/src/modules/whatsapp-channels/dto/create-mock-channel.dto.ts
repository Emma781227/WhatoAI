import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateMockChannelDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;

  /** Numéro au format international — normalisé en E.164 côté service. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  phoneNumber!: string;
}
