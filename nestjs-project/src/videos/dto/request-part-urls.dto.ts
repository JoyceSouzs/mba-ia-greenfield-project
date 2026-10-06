import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  Max,
  Min,
} from 'class-validator';

export class RequestPartUrlsDto {
  @ApiProperty({
    type: [Number],
    description:
      'Part numbers to sign (1–10000, S3 limit). At most 1000 URLs per call.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(10000, { each: true })
  partNumbers: number[];
}
