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

// Objectives are sourced from Overpass for exactly these seven categories:
// Hospitals, Train Stations, Cinemas, Libraries, Museums, Parks, Restaurants.
export const OVERPASS_CATEGORIES: OverpassCategory[] = [
  { category: "hospital", filters: ['["amenity"="hospital"]'] },
  { category: "station", filters: ['["railway"="station"]'] },
  { category: "cinema", filters: ['["amenity"="cinema"]'] },
  { category: "library", filters: ['["amenity"="library"]'] },
  { category: "museum", filters: ['["tourism"="museum"]'] },
  { category: "park", filters: ['["leisure"="park"]'] },
  { category: "restaurant", filters: ['["amenity"="restaurant"]'] },
  { category: "consulate", filters: ['["office"="diplomatic"]'] },
  { category: "golf", filters: ['["leisure"="golf_course"]'] }
];

// Single source of truth for the categories an objective may belong to.
export const OBJECTIVE_CATEGORIES: PoiCategory[] = OVERPASS_CATEGORIES.map(c => c.category);

// Map raw OSM tags to one of our seven objective categories (null = not an objective POI).
export function categoryForTags(tags: Record<string, string>): PoiCategory | null {
  if (tags.amenity === "hospital") return "hospital";
  if (tags.railway === "station") return "station";
  if (tags.amenity === "cinema") return "cinema";
  if (tags.amenity === "library") return "library";
  if (tags.tourism === "museum") return "museum";
  if (tags.leisure === "park") return "park";
  if (tags.amenity === "restaurant") return "restaurant";
  if (tags.office === "diplomatic") return "consulate";
  if (tags.leisure === "golf_course") return "golf";
  return null;
}

// Convert a raw Overpass element into a named, categorised Objective (null if unusable).
export function osmElementToObjective(element: OverpassElement, source: "postgis" | "overpass" = "overpass"): Objective | null {
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
    source,
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
