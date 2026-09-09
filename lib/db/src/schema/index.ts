import { createInsertSchema } from "drizzle-zod";
import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const customersTable = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    mobile: text("mobile").notNull(),
    email: text("email").notNull(),
    city: text("city").notNull(),
    afNumber: text("af_number"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    gender: text("gender"),
    relation: text("relation"),
    address: text("address"),
    membershipStatus: text("membership_status").notNull().default("ACTIVE"),
    createdBy: text("created_by").notNull().default("Staff user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("customers_name_idx").on(table.name),
    index("customers_mobile_idx").on(table.mobile),
    index("customers_email_idx").on(table.email),
    index("customers_af_number_idx").on(table.afNumber),
  ],
);

export const membershipsTable = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => customersTable.id),
    product: text("product").notNull(),
    tenureYears: integer("tenure_years").notNull(),
    totalAmount: integer("total_amount").notNull(),
    normalNightsAllocated: integer("normal_nights_allocated").notNull(),
    offerNightsAllocated: integer("offer_nights_allocated").notNull(),
    normalNightsUsed: integer("normal_nights_used").notNull().default(0),
    offerNightsUsed: integer("offer_nights_used").notNull().default(0),
    createdBy: text("created_by").notNull().default("Staff user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("memberships_customer_idx").on(table.customerId)],
);

export const paymentsTable = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => customersTable.id),
    membershipId: text("membership_id").notNull().references(() => membershipsTable.id),
    receiptNumber: text("receipt_number").notNull().unique(),
    amount: integer("amount").notNull(),
    previouslyPaid: integer("previously_paid").notNull(),
    totalPaid: integer("total_paid").notNull(),
    remainingDue: integer("remaining_due").notNull(),
    method: text("method").notNull(),
    reference: text("reference"),
    remarks: text("remarks"),
    createdBy: text("created_by").notNull().default("Staff user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("payments_customer_idx").on(table.customerId),
    index("payments_created_at_idx").on(table.createdAt),
  ],
);

export const redemptionsTable = pgTable(
  "redemptions",
  {
    id: text("id").primaryKey(),
    customerId: text("customer_id").notNull().references(() => customersTable.id),
    membershipId: text("membership_id").notNull().references(() => membershipsTable.id),
    nightType: text("night_type").notNull(),
    nights: integer("nights").notNull(),
    travelType: text("travel_type").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    hotelName: text("hotel_name"),
    city: text("city"),
    checkIn: date("check_in", { mode: "string" }),
    checkOut: date("check_out", { mode: "string" }),
    hotelNights: integer("hotel_nights"),
    costPerNight: integer("cost_per_night"),
    totalHotelCost: integer("total_hotel_cost"),
    roomNumber: text("room_number"),
    createdBy: text("created_by").notNull().default("Staff user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("redemptions_customer_idx").on(table.customerId)],
);

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    module: text("module").notNull(),
    recordId: text("record_id").notNull(),
    userName: text("user_name").notNull(),
    detail: text("detail").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_timestamp_idx").on(table.timestamp)],
);

export const insertCustomerSchema = createInsertSchema(customersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertMembershipSchema = createInsertSchema(membershipsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({
  id: true,
  createdAt: true,
});
export const insertRedemptionSchema = createInsertSchema(redemptionsTable).omit({
  id: true,
  createdAt: true,
});
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  timestamp: true,
});

export type Customer = typeof customersTable.$inferSelect;
export type Membership = typeof membershipsTable.$inferSelect;
export type Payment = typeof paymentsTable.$inferSelect;
export type Redemption = typeof redemptionsTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type InsertMembership = z.infer<typeof insertMembershipSchema>;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type InsertRedemption = z.infer<typeof insertRedemptionSchema>;
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;