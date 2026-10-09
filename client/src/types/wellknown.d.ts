declare module "wellknown" {
  import type { Geometry } from "geojson";
  export function parse(input: string): Geometry | null;
}
