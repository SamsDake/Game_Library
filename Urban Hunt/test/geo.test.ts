import { afterEach, describe, expect, it, vi } from "vitest";
import { circlePolygon, containsPoint, containsPointWithBuffer, delayedCoordinate, legalArea, shrinkGlobalZone } from "../server/src/geo";
import type { SeekerState } from "../shared/types";

describe("geospatial rules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shrinks the global zone using seeker midpoint as origin", () => {
    const zone = circlePolygon([-0.1, 51.5], 1000);
    const seekers: SeekerState[] = [
      { playerId: "s1", name: "A", coords: [-0.099, 51.5], history: [] },
      { playerId: "s2", name: "B", coords: [-0.098, 51.5], history: [] }
    ];
    const shrunk = shrinkGlobalZone(zone, seekers, 25);
    expect(JSON.stringify(shrunk.geometry.coordinates)).not.toEqual(JSON.stringify(zone.geometry.coordinates));
  });

  it("intersects lockdown with the global safe zone", () => {
    const global = circlePolygon([-0.1, 51.5], 600);
    const lockdown = circlePolygon([-0.096, 51.5], 600);
    const legal = legalArea(global, lockdown);
    expect(containsPoint(legal, [-0.1, 51.5])).toBe(true);
    expect(containsPoint(legal, [-0.088, 51.5])).toBe(false);
  });

  it("supports the 20m OOB buffer", () => {
    const zone = circlePolygon([-0.1, 51.5], 100);
    expect(containsPoint(zone, [-0.1, 51.5])).toBe(true);
    expect(containsPointWithBuffer(zone, [-0.1, 51.50105], 20)).toBe(true);
  });

  it("uses the newest available delayed coordinate when all samples are older than the delay", () => {
    vi.setSystemTime(1_000_000);
    const history = [
      { coordinates: [-0.1, 51.5] as const, timestamp: 100_000 },
      { coordinates: [-0.2, 51.6] as const, timestamp: 200_000 }
    ];

    expect(delayedCoordinate(history, 3).coordinates).toEqual([-0.2, 51.6]);
  });
});
