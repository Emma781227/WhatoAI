import { ApiProperty } from '@nestjs/swagger';
import { DayOfWeek } from '@whauto/database';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  Matches,
  ValidateNested,
} from 'class-validator';

import { formatMinutes } from '../opening-hours.util';
import type { OpeningHourRow } from '../shops.mapper';

const HHMM_MESSAGE = 'time must be in HH:mm format (00:00-23:59)';

export class OpeningHourPeriodDto {
  @ApiProperty({ example: '08:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: HHMM_MESSAGE })
  opensAt!: string;

  @ApiProperty({ example: '18:00' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: HHMM_MESSAGE })
  closesAt!: string;
}

export class OpeningHourDayDto {
  @ApiProperty({ enum: DayOfWeek })
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @ApiProperty({ description: 'true = fermé (periods doit être vide)' })
  @IsBoolean()
  isClosed!: boolean;

  @ApiProperty({ type: [OpeningHourPeriodDto] })
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => OpeningHourPeriodDto)
  periods!: OpeningHourPeriodDto[];
}

/** Remplacement COMPLET : les jours absents de la liste sont considérés fermés. */
export class ReplaceOpeningHoursDto {
  @ApiProperty({ type: [OpeningHourDayDto] })
  @IsArray()
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => OpeningHourDayDto)
  days!: OpeningHourDayDto[];
}

const WEEK_ORDER: DayOfWeek[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export class OpeningHoursResponseDto {
  @ApiProperty({ example: 'Africa/Douala', description: 'Fuseau horaire hérité de la Shop' })
  timezone!: string;

  @ApiProperty({ type: [OpeningHourDayDto] })
  days!: OpeningHourDayDto[];

  /** Reconstruit les 7 jours ordonnés : un jour sans ligne = fermé. */
  static fromRows(timezone: string, rows: OpeningHourRow[]): OpeningHoursResponseDto {
    const dto = new OpeningHoursResponseDto();
    dto.timezone = timezone;
    dto.days = WEEK_ORDER.map((dayOfWeek) => {
      const periods = rows
        .filter((row) => row.dayOfWeek === dayOfWeek)
        .sort((a, b) => a.opensAtMinutes - b.opensAtMinutes)
        .map((row) => ({
          opensAt: formatMinutes(row.opensAtMinutes),
          closesAt: formatMinutes(row.closesAtMinutes),
        }));
      return { dayOfWeek, isClosed: periods.length === 0, periods };
    });
    return dto;
  }
}
