import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the identity hand-off must not navigate the popup off this origin', () => {
  const source = readFileSync(join(__dirname, 'sep24.service.ts'), 'utf8');

  const anchors = source.match(/<a href="\$\{escapeHtml\([^)]*\)\}"[^>]*>/g) ?? [];

  it('renders the link that reaches the identity provider, on the waiting screen that refreshes', () => {
    expect(anchors.length).toBeGreaterThanOrEqual(1);
  });

  it('opens every one of them in a new window, because the provider sets its own COOP', () => {
    for (const a of anchors) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener"');
    }
  });
});
