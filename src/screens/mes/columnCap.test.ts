import { describe, expect, it } from 'vitest';
import { capHeight, sideBySide } from './columnCap';

describe('capHeight', () => {
  it('caps at the right column height when side by side', () => {
    expect(capHeight(true, 640.4)).toBe(640);
  });
  it('rounds up', () => {
    expect(capHeight(true, 640.6)).toBe(641);
  });
  it('does not cap when the columns are stacked', () => {
    expect(capHeight(false, 640)).toBeNull();
  });
  it('does not cap before the column has a height', () => {
    expect(capHeight(true, 0)).toBeNull();
  });
  it('does not cap on a height that rounds to 0', () => {
    expect(capHeight(true, 0.3)).toBeNull();
  });
  it('does not cap on NaN or negative heights', () => {
    expect(capHeight(true, NaN)).toBeNull();
    expect(capHeight(true, -20)).toBeNull();
  });
  it('caps a tiny but real height', () => {
    expect(capHeight(true, 0.6)).toBe(1);
  });
});

describe('sideBySide', () => {
  it('is true when both columns start at the same offset', () => {
    expect(sideBySide(24, 24)).toBe(true);
  });
  it('is false when the right column wrapped below', () => {
    expect(sideBySide(24, 700)).toBe(false);
  });
});
