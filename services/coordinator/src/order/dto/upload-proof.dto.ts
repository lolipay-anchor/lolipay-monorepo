import { IsOptional, IsString, Matches, IsISO8601 } from 'class-validator';

export const PROOF_RRN_RE = /^[A-Za-z0-9]{6,40}$/;

export const PROOF_AMOUNT_RE = /^[1-9][0-9]{0,14}$/;

export class UploadProofDto {
  @IsOptional()
  @IsString()
  @Matches(PROOF_RRN_RE, { message: 'rrn must be 6-40 alphanumeric characters' })
  rrn?: string;

  @IsOptional()
  @IsString()
  @Matches(PROOF_AMOUNT_RE, { message: 'paidAmount must be a positive integer (base units)' })
  paidAmount?: string;

  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true }, { message: 'paidAt must be an ISO-8601 timestamp' })
  paidAt?: string;
}
