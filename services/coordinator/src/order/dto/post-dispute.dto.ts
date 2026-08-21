import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import { ALL_DISPUTE_REASONS } from '../dispute.util';

export const DISPUTE_NOTE_ALLOWED_RE = /^[^\x00-\x08\x0B\x0C\x0E-\x1F\x7F]*$/;
export const DISPUTE_NOTE_MAX_LEN = 500;

export const EVIDENCE_URL_RE = /^evidence\/[A-Za-z0-9-]+\.(jpg|png|webp|pdf)$/;

export class PostDisputeDto {
  @IsString()
  @IsIn(ALL_DISPUTE_REASONS)
  reason!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DISPUTE_NOTE_MAX_LEN)
  @Matches(DISPUTE_NOTE_ALLOWED_RE, { message: 'note must not contain control characters' })
  note!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Matches(EVIDENCE_URL_RE, { message: 'evidenceUrl must be a valid evidence/<file> path' })
  evidenceUrl?: string;
}
