import { describe, expect, it } from 'vitest';
import { carouselIndex } from './cardCarousel';

describe('carouselIndex', () => {
  it('keeps the index when nothing changed', () => {
    expect(carouselIndex(['a', 'b'], ['a', 'b'], 1)).toBe(1);
  });
  it('clamps when cards are removed', () => {
    expect(carouselIndex(['a', 'b', 'c'], ['a', 'b'], 2)).toBe(1);
    expect(carouselIndex(['a'], [], 0)).toBe(0);
  });
  it('jumps to a newly added card', () => {
    expect(carouselIndex(['a', 'b'], ['a', 'b', 'c'], 0)).toBe(2);
  });
  it('does not jump when the list was empty', () => {
    expect(carouselIndex([], ['a', 'b'], 0)).toBe(0);
  });
});
