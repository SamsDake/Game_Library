import { describe, expect, it } from "vitest";
import { destPoint, distanceMeters } from "../server/src/geo";

describe("geospatial helpers", () => {
  it("computes zero distance for identical points", () => {
    expect(distanceMeters([-0.1, 51.5], [-0.1, 51.5])).toBeCloseTo(0, 5);
  });

  it("computes a plausible haversine distance", () => {
    // Roughly 1km apart along a line of latitude near London.
    const d = distanceMeters([-0.1, 51.5], [-0.1143, 51.5]);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });

  it("destPoint lands distanceMeters away from the origin", () => {
    const origin: [number, number] = [-0.1, 51.5];
    const dest = destPoint(origin, 90, 500);
    expect(distanceMeters(origin, dest)).toBeCloseTo(500, 0);
  });
});
