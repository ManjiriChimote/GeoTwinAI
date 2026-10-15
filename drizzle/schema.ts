import {
  bigint,
  double,
  index,
  int,
  longtext,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/** Existing starter authentication table. */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const geoDatasets = mysqlTable("geotwin_datasets", {
  id: int("id").autoincrement().primaryKey(),
  datasetKey: varchar("dataset_key", { length: 160 }).notNull(),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  category: varchar("category", { length: 64 }).notNull(),
  sourceFile: varchar("source_file", { length: 255 }).notNull(),
  sourceType: mysqlEnum("source_type", ["seed", "upload"]).notNull(),
  status: mysqlEnum("status", ["ready", "processing", "error"]).default("processing").notNull(),
  active: int("active").default(1).notNull(),
  totalRecords: int("total_records").default(0).notNull(),
  mappedRecords: int("mapped_records").default(0).notNull(),
  invalidCoordinates: int("invalid_coordinates").default(0).notNull(),
  metadata: longtext("metadata"),
  sourceHash: varchar("source_hash", { length: 64 }),
  importedAt: timestamp("imported_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => ({
  keyUq: uniqueIndex("geotwin_datasets_key_uq").on(table.datasetKey),
  categoryIdx: index("geotwin_datasets_category_idx").on(table.category, table.active),
}));

export const geoFeatures = mysqlTable("geotwin_features", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  datasetId: int("dataset_id").notNull().references(() => geoDatasets.id, { onDelete: "cascade" }),
  category: varchar("category", { length: 64 }).notNull(),
  region: varchar("region", { length: 64 }),
  featureHash: varchar("feature_hash", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }),
  latitude: double("latitude"),
  longitude: double("longitude"),
  geometryType: varchar("geometry_type", { length: 32 }),
  geometry: longtext("geometry"),
  properties: longtext("properties").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => ({
  dedupe: uniqueIndex("geotwin_features_dataset_hash_uq").on(table.datasetId, table.featureHash),
  categoryRegion: index("geotwin_features_category_region_idx").on(table.category, table.region),
  datasetCategory: index("geotwin_features_dataset_category_idx").on(table.datasetId, table.category),
  latLon: index("geotwin_features_lat_lon_idx").on(table.latitude, table.longitude),
}));

export const geoImports = mysqlTable("geotwin_imports", {
  id: int("id").autoincrement().primaryKey(),
  datasetId: int("dataset_id").references(() => geoDatasets.id, { onDelete: "set null" }),
  sourceFile: varchar("source_file", { length: 255 }).notNull(),
  category: varchar("category", { length: 64 }).notNull(),
  status: mysqlEnum("status", ["previewed", "processing", "succeeded", "failed"]).notNull(),
  recordsRead: int("records_read").default(0).notNull(),
  recordsImported: int("records_imported").default(0).notNull(),
  invalidCoordinates: int("invalid_coordinates").default(0).notNull(),
  duplicateRecords: int("duplicate_records").default(0).notNull(),
  details: longtext("details"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
}, table => ({
  history: index("geotwin_imports_started_idx").on(table.startedAt),
}));

export const geoMetrics = mysqlTable("geotwin_metrics", {
  id: int("id").autoincrement().primaryKey(),
  metricKey: varchar("metric_key", { length: 190 }).notNull(),
  sourceFile: varchar("source_file", { length: 255 }).notNull(),
  payload: longtext("payload").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow().notNull(),
}, table => ({
  keyUq: uniqueIndex("geotwin_metrics_key_uq").on(table.metricKey),
}));

export const geoAnalyses = mysqlTable("geotwin_analyses", {
  id: int("id").autoincrement().primaryKey(),
  analysisType: varchar("analysis_type", { length: 80 }).notNull(),
  region: varchar("region", { length: 64 }),
  parameters: longtext("parameters").notNull(),
  result: longtext("result").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => ({
  history: index("geotwin_analyses_created_idx").on(table.createdAt),
}));

export const geoChatMessages = mysqlTable("geotwin_chat_messages", {
  id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
  conversationId: varchar("conversation_id", { length: 80 }).notNull(),
  role: mysqlEnum("role", ["user", "assistant"]).notNull(),
  content: longtext("content").notNull(),
  context: longtext("context"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => ({
  conversationIdx: index("geotwin_chat_conversation_idx").on(table.conversationId, table.id),
}));

/** First-party email/password accounts for the GeoTwinAI workspace. */
export const geoTwinAccounts = mysqlTable("geotwin_accounts", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 254 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  termsVersion: varchar("terms_version", { length: 32 }).notNull(),
  termsAcceptedAt: timestamp("terms_accepted_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastSignedIn: timestamp("last_signed_in").defaultNow().notNull(),
}, table => ({
  emailUq: uniqueIndex("geotwin_accounts_email_uq").on(table.email),
  createdIdx: index("geotwin_accounts_created_idx").on(table.createdAt),
}));

/** Opaque, hashed, expiring sessions; raw session tokens exist only in secure cookies. */
export const geoTwinSessions = mysqlTable("geotwin_sessions", {
  tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
  accountId: int("account_id").notNull().references(() => geoTwinAccounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, table => ({
  accountIdx: index("geotwin_sessions_account_idx").on(table.accountId),
  expiresIdx: index("geotwin_sessions_expires_idx").on(table.expiresAt),
}));
