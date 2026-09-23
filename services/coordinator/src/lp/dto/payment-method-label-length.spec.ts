import { readFileSync } from 'fs';
import { join } from 'path';
import { PAYMENT_METHOD_LABEL_MAX_LEN } from '../../order/payment-destination';

function schemaVarCharLen(modelName: string, fieldName: string): number {
  const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf8');
  const model = schema.match(new RegExp(`model ${modelName} \\{[\\s\\S]*?\\n\\}`))?.[0];
  expect(model).toBeDefined();
  const found = (model as string).match(new RegExp(`${fieldName}\\s+String\\??\\s+@db\\.VarChar\\((\\d+)\\)`));
  expect(found).not.toBeNull();
  return Number((found as RegExpMatchArray)[1]);
}

describe('PaymentMethod.label, Order.lpPaymentLabel and the DTO MaxLength all agree on one width', () => {
  it('PaymentMethod.label is VarChar(64) in the schema', () => {
    expect(schemaVarCharLen('PaymentMethod', 'label')).toBe(PAYMENT_METHOD_LABEL_MAX_LEN);
  });

  it('Order.lpPaymentLabel is VarChar(64) in the schema, the same width it was snapshotted from', () => {
    expect(schemaVarCharLen('Order', 'lpPaymentLabel')).toBe(PAYMENT_METHOD_LABEL_MAX_LEN);
  });
});
