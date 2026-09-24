import { ValidateBy, ValidationOptions, buildMessage } from 'class-validator';
import {
  PAYMENT_METHOD_LABEL_BAD_CHARS_RE,
  PAYMENT_METHOD_LABEL_DIGIT_RE,
  PAYMENT_METHOD_LABEL_HAS_LETTERS_RE,
  PAYMENT_METHOD_LABEL_LENGTH_RE,
  PAYMENT_METHOD_LABEL_MAX_DIGITS,
  PAYMENT_METHOD_LABEL_MAX_LEN,
} from '../../order/payment-destination';

export const PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE =
  "Depositors see this label, so it needs the institution's name, not the account number.";
export const PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE = `That label is too long. The limit is ${PAYMENT_METHOD_LABEL_MAX_LEN} characters — the institution's name is enough.`;
export const PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE =
  'That label contains characters this anchor cannot pass on to a depositor. Type the name in by hand.';

export function IsPaymentMethodLabelLength(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isPaymentMethodLabelLength',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'string' || PAYMENT_METHOD_LABEL_LENGTH_RE.test(value),
        defaultMessage: buildMessage(() => PAYMENT_METHOD_LABEL_TOO_LONG_MESSAGE, validationOptions),
      },
    },
    validationOptions,
  );
}

export function HasNoDisallowedPaymentMethodChars(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'hasNoDisallowedPaymentMethodChars',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'string' || PAYMENT_METHOD_LABEL_BAD_CHARS_RE.test(value),
        defaultMessage: buildMessage(() => PAYMENT_METHOD_LABEL_BAD_CHARS_MESSAGE, validationOptions),
      },
    },
    validationOptions,
  );
}

function isNotAccountOrPhoneNumberShaped(value: string): boolean {
  const digitCount = (value.match(PAYMENT_METHOD_LABEL_DIGIT_RE) ?? []).length;
  return digitCount <= PAYMENT_METHOD_LABEL_MAX_DIGITS;
}

export function HasReadablePaymentMethodName(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'hasReadablePaymentMethodName',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value !== 'string' ||
          (PAYMENT_METHOD_LABEL_HAS_LETTERS_RE.test(value) && isNotAccountOrPhoneNumberShaped(value)),
        defaultMessage: buildMessage(() => PAYMENT_METHOD_LABEL_NO_NAME_MESSAGE, validationOptions),
      },
    },
    validationOptions,
  );
}
