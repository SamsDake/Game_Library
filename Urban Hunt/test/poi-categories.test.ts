import { describe, expect, it } from "vitest";
import { categoryForTags, OVERPASS_CATEGORIES, overpassQueryBlocks } from "../shared/poi-categories";
import { POI_CATEGORY_LABELS } from "../shared/types";

describe("POI categories", () => {
  it("preloads pubs and bars from Overpass", () => {
    const categories = OVERPASS_CATEGORIES.map(item => item.category);
    expect(categories).toContain("pub");
    expect(categories).toContain("bar");

    const query = overpassQueryBlocks("51,-1,52,0");
    expect(query).toContain('["amenity"="pub"]');
    expect(query).toContain('["amenity"="bar"]');
  });

  it("maps pub and bar OSM tags to objective categories", () => {
    expect(categoryForTags({ amenity: "pub" })).toBe("pub");
    expect(categoryForTags({ amenity: "bar" })).toBe("bar");
    expect(POI_CATEGORY_LABELS.pub).toBe("Pub");
    expect(POI_CATEGORY_LABELS.bar).toBe("Bar");
  });
});
