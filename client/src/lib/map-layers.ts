import type { Category } from "./geotwin-api";

export const categoryColor: Record<Category, string> = {
  Buildings: "#9b8068",
  Roads: "#527c8c",
  Hospitals: "#c66a5b",
  Schools: "#7287a0",
  Parks: "#778c69",
  "Water bodies": "#648fa0",
  "Green cover": "#829774",
  "Flood risk": "#c66a5b",
  "Built-up": "#867f76",
  NDVI: "#9aa969",
};

export const mapLayerOptions: { name: Category; categories: Category[]; label: string; color: string }[] = [
  { name: "Buildings", categories: ["Buildings"], label: "Buildings", color: categoryColor.Buildings },
  { name: "Built-up", categories: ["Built-up"], label: "Built-up", color: categoryColor["Built-up"] },
  { name: "Roads", categories: ["Roads"], label: "Roads", color: categoryColor.Roads },
  { name: "Hospitals", categories: ["Hospitals"], label: "Hospitals", color: categoryColor.Hospitals },
  { name: "Schools", categories: ["Schools"], label: "Schools", color: categoryColor.Schools },
  { name: "Parks", categories: ["Parks"], label: "Parks", color: categoryColor.Parks },
  { name: "Green cover", categories: ["Green cover"], label: "Green", color: categoryColor["Green cover"] },
  { name: "Water bodies", categories: ["Water bodies"], label: "Water", color: categoryColor["Water bodies"] },
  { name: "Flood risk", categories: ["Flood risk"], label: "Risk", color: categoryColor["Flood risk"] },
  { name: "NDVI", categories: ["NDVI"], label: "NDVI", color: categoryColor.NDVI },
];

export const defaultMapCategories: Category[] = mapLayerOptions.flatMap(layer => layer.categories);
