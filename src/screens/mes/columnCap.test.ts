import { describe, expect, it } from 'vitest';
import { capHeight } from './columnCap';

describe('capHeight', () => {
  it('caps at the right column height when side by side', () => {
    expect(capHeight(true, 640.4)).toBe(640);
  });
  it('does not cap when the columns are stacked', () => {
    expect(capHeight(false, 640)).toBeNull();
  });
  it('does not cap before the column has a height', () => {
    expect(capHeight(true, 0)).toBeNull();
  });
});
