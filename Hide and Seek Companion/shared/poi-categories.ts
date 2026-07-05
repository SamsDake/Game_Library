import type { Objective, PoiCategory } from "./types";

export interface OverpassCategory {
  category: PoiCategory;
  filters: string[];
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Objectives are sourced from Overpass for exactly these thirteen categories.
export const OVERPASS_CATEGORIES: OverpassCategory[] = [
  { category: "park", filters: ['["leisure"="park"]'] },
  { category: "pub", filters: ['["amenity"="pub"]'] },
  { category: "bar", filters: ['["amenity"="bar"]'] },
  { category: "restaurant", filters: ['["amenity"="restaurant"]'] },
  { category: "cafe", filters: ['["amenity"="cafe"]'] },
  { category: "museum", filters: ['["tourism"="museum"]'] },
  { category: "library", filters: ['["amenity"="library"]'] },
  { category: "cinema", filters: ['["amenity"="cinema"]'] },
  { category: "shop", filters: ['["shop"]'] },
  { category: "golf", filters: ['["leisure"="golf_course"]'] },
  { category: "aquarium", filters: ['["tourism"="aquarium"]'] },
  { category: "hospital", filters: ['["amenity"="hospital"]'] },
  { category: "station", filters: ['["railway"="station"]'] }
];

// Single source of truth for the categories an objective may belong to.
export const OBJECTIVE_CATEGORIES: PoiCategory[] = OVERPASS_CATEGORIES.map(c => c.category);

// Map raw OSM tags to one of our thirteen objective categories (null = not an objective POI).
export function categoryForTags(tags: Record<string, string>): PoiCategory | null {
  if (tags.leisure === "park") return "park";
  if (tags.amenity === "pub") return "pub";
  if (tags.amenity === "bar") return "bar";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.amenity === "cafe") return "cafe";
  if (tags.tourism === "museum") return "museum";
  if (tags.amenity === "library") return "library";
  if (tags.amenity === "cinema") return "cinema";
  if (tags.shop != null) return "shop";
  if (tags.leisure === "golf_course") return "golf";
  if (tags.tourism === "aquarium") return "aquarium";
  if (tags.amenity === "hospital") return "hospital";
  if (tags.railway === "station") return "station";
  return null;
}

// Convert a raw Overpass element into a named, categorised Objective (null if unusable).
export function osmElementToObjective(element: OverpassElement): Objective | null {
  const tags = element.tags || {};
  const name = tags.name || tags["official_name"] || tags["operator"];
  const center = element.center || (element.lat != null && element.lon != null ? { lat: element.lat, lon: element.lon } : null);
  if (!name || !center) return null;
  const category = categoryForTags(tags);
  if (!category) return null;
  return {
    id: `osm-${element.type}-${element.id}`,
    name,
    category,
    coordinates: [center.lon, center.lat],
    osmType: element.type,
    osmId: String(element.id)
  };
}

// Build the Overpass QL union body for all objective categories within a bbox ("south,west,north,east").
export function overpassQueryBlocks(bboxText: string): string {
  return OVERPASS_CATEGORIES.flatMap(cat =>
    cat.filters.flatMap(filter => [
      `node${filter}(${bboxText});`,
      `way${filter}(${bboxText});`,
      `relation${filter}(${bboxText});`
    ])
  ).join("\n");
}

// Build the Overpass QL union body for a single category, scoped to a named area set (".a").
export function overpassCategoryAreaQuery(category: PoiCategory): string {
  const cat = OVERPASS_CATEGORIES.find(c => c.category === category);
  if (!cat) throw new Error(`unknown category: ${category}`);
  return cat.filters.flatMap(filter => [
    `node${filter}(area.a);`,
    `way${filter}(area.a);`,
    `relation${filter}(area.a);`
  ]).join("\n");
}
