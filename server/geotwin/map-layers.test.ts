import { describe, expect, it } from "vitest";
import { defaultMapCategories, mapLayerOptions } from "../../client/src/lib/map-layers";

describe("internal map layer controls", () => {
  it("makes every GIS category independently toggleable and visible by default", () => {
    const options = mapLayerOptions.flatMap(layer => layer.categories);
    const expected = [
      "Buildings", "Built-up", "Roads", "Hospitals", "Schools", "Parks", "Green cover",
      "Water bodies", "Flood risk", "NDVI",
    ];
    expect(options).toHaveLength(expected.length);
    expect(new Set(options)).toEqual(new Set(expected));
    expect(defaultMapCategories).toEqual(expected);
  });
});
