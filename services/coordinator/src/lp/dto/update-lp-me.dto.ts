import { IsOptional, MaxLength, ValidateBy, ValidationOptions, buildMessage } from 'class-validator';
import { EMAIL_MAX_LENGTH, HAS_BOTH_SIDES, HAS_SPACE_OR_CONTROL } from '../../kyc/email-address';

export const ALERT_EMAIL_FORMAT_MESSAGE = 'That does not look like an email address. Check it and try again.';
export const ALERT_EMAIL_TOO_LONG_MESSAGE = `That address is too long. The limit is ${EMAIL_MAX_LENGTH} characters.`;
export const ALERT_EMAIL_UNPRINTABLE_MESSAGE = 'An email address cannot contain spaces or invisible characters.';

function HasNoSpaceOrControl(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'hasNoSpaceOrControl',
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && !HAS_SPACE_OR_CONTROL.test(value),
        defaultMessage: buildMessage(() => ALERT_EMAIL_UNPRINTABLE_MESSAGE, validationOptions),
      },
    },
    validationOptions,
  );
}

function IsEmailShape(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isEmailShape',
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && HAS_BOTH_SIDES.test(value),
        defaultMessage: buildMessage(() => ALERT_EMAIL_FORMAT_MESSAGE, validationOptions),
      },
    },
    validationOptions,
  );
}

export class UpdateLpMeDto {
  @IsOptional()
  @MaxLength(EMAIL_MAX_LENGTH, { message: ALERT_EMAIL_TOO_LONG_MESSAGE })
  @HasNoSpaceOrControl()
  @IsEmailShape()
  alertEmail!: string | null;
}
