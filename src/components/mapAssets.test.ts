/**
 * The silhouette a vessel gets is decided from free text the registry supplies, so the matching has
 * to cope with the spellings that actually turn up rather than a tidy enumeration.
 */
import { describe, expect, it } from 'vitest';
import { vesselShape } from './mapAssets';

describe('choosing a vessel silhouette', () => {
  it('recognises the ship types that carry oil', () => {
    expect(vesselShape('Crude Oil Tanker')).toBe('tanker');
    expect(vesselShape('LPG Tanker')).toBe('tanker');
    expect(vesselShape('Chemical/Products Tanker')).toBe('tanker');
  });

  it('tells cargo, bulk and container ships apart from tankers', () => {
    expect(vesselShape('Container Ship')).toBe('cargo');
    expect(vesselShape('General Cargo')).toBe('cargo');
    expect(vesselShape('Bulk Carrier')).toBe('bulk');
  });

  it('recognises fishing vessels by the words the feed uses', () => {
    expect(vesselShape('Fishing')).toBe('fishing');
    expect(vesselShape('drifting_longlines')).toBe('fishing');
    expect(vesselShape('squid_jigger')).toBe('fishing');
    expect(vesselShape('Trawler')).toBe('fishing');
  });

  it('separates the vessels that turn up at a spill to help', () => {
    expect(vesselShape('Patrol Vessel')).toBe('patrol');
    expect(vesselShape('ICGS Samarth')).toBe('patrol');
    expect(vesselShape('Offshore Supply Ship')).toBe('tug');
    expect(vesselShape('Tug')).toBe('tug');
  });

  it('gives passengers and fixed installations their own shapes', () => {
    expect(vesselShape('Passenger Ferry')).toBe('passenger');
    expect(vesselShape('Cruise Ship')).toBe('passenger');
    expect(vesselShape('Oil Platform')).toBe('platform');
  });

  it('draws a plain hull rather than guessing', () => {
    expect(vesselShape(undefined)).toBe('plain');
    expect(vesselShape('')).toBe('plain');
    expect(vesselShape('Unknown')).toBe('plain');
  });
});
