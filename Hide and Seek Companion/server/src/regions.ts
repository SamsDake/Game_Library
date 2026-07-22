export interface RegionDef {
  id: string;
  label: string;
  // Overpass QL area-selector filters, applied after `area[...]->.a;` so category queries can
  // scope to `(area.a)` instead of a lat/lng bounding box. Add an entry here to preload another
  // country/region later — no other code changes needed.
  overpassAreaQuery: string;
}

export const REGIONS: RegionDef[] = [
  { id: "united-kingdom", label: "United Kingdom", overpassAreaQuery: '["ISO3166-1"="GB"][admin_level=2]' },
  { id: "france", label: "France", overpassAreaQuery: '["ISO3166-1"="FR"][admin_level=2]' }
];

export function findRegion(id: string): RegionDef | undefined {
  return REGIONS.find(r => r.id === id);
}
