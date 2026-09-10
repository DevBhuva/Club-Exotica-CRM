import { Router, type IRouter } from "express";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { clerkClient, getAuth } from "@clerk/express";
import {
  CreateCustomerBody,
  CreatePaymentBody,
  CreateRedemptionBody,
  ListAuditLogsQueryParams,
  ListCustomersQueryParams,
  UpdateCustomerBody,
} from "@workspace/api-zod";
import {
  auditLogsTable,
  customersTable,
  db,
  membershipsTable,
  paymentsTable,
  redemptionsTable,
} from "@workspace/db";

const router: IRouter = Router();

router.use((req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

type StaffRole = "SUPER_ADMIN" | "USER";
type StaffUser = Awaited<ReturnType<typeof clerkClient.users.getUser>>;

function staffRole(user: StaffUser): StaffRole {
  return (user.publicMetadata as { role?: string }).role === "SUPER_ADMIN"
    ? "SUPER_ADMIN"
    : "USER";
}

function staffEmail(user: StaffUser) {
  return user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? "";
}

function serializeStaffUser(user: StaffUser) {
  return {
    id: user.id,
    email: staffEmail(user),
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    role: staffRole(user),
    createdAt: new Date(user.createdAt).toISOString(),
    lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null,
  };
}

function staffRequestError(error: unknown, fallback: string) {
  const clerkError = error as { errors?: Array<{ code?: string; longMessage?: string; message?: string }> };
  const first = clerkError.errors?.[0];
  if (first?.code === "form_identifier_exists") return "That email address is already in use.";
  return first?.longMessage ?? first?.message ?? fallback;
}

async function currentStaffUser(req: Parameters<NonNullable<Parameters<typeof router.use>[1]>>[0]) {
  const auth = getAuth(req);
  return auth.userId ? clerkClient.users.getUser(auth.userId) : null;
}

async function requireSuperAdmin(req: Parameters<NonNullable<Parameters<typeof router.use>[1]>>[0], res: Parameters<NonNullable<Parameters<typeof router.use>[1]>>[1], next: Parameters<NonNullable<Parameters<typeof router.use>[1]>>[2]) {
  try {
    const user = await currentStaffUser(req);
    if (!user || staffRole(user) !== "SUPER_ADMIN") {
      res.status(403).json({ error: "Super admin access required" });
      return;
    }
    res.locals.staffUser = user;
    next();
  } catch (error) {
    req.log.error({ error }, "Failed to load staff authorization");
    res.status(403).json({ error: "Unable to verify staff access" });
  }
}

router.get("/staff/me", async (req, res) => {
  try {
    const user = await currentStaffUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.json(serializeStaffUser(user));
  } catch (error) {
    req.log.error({ error }, "Failed to load staff profile");
    res.status(500).json({ error: "Unable to load staff profile" });
  }
});

router.get("/staff/users", requireSuperAdmin, async (req, res) => {
  try {
    const result = await clerkClient.users.getUserList({ limit: 100, orderBy: "-created_at" });
    res.json(result.data.map(serializeStaffUser));
  } catch (error) {
    req.log.error({ error }, "Failed to list staff users");
    res.status(500).json({ error: "Unable to list staff users" });
  }
});

router.post("/staff/users", requireSuperAdmin, async (req, res) => {
  try {
    const { email, password, firstName = "", lastName = "", role = "USER" } = req.body as {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      role?: StaffRole;
    };
    if (!email || !password || password.length < 15 || !["SUPER_ADMIN", "USER"].includes(role)) {
      res.status(400).json({ error: "Email, password of at least 15 characters, and a valid role are required." });
      return;
    }
    const user = await clerkClient.users.createUser({
      emailAddress: [email.trim().toLowerCase()],
      password,
      firstName: firstName.trim() || undefined,
      lastName: lastName.trim() || undefined,
      publicMetadata: { role },
    });
    await addAudit("STAFF_USER_CREATED", "staff-users", user.id, `${email} created as ${role}`);
    res.status(201).json(serializeStaffUser(user));
  } catch (error) {
    req.log.error({ error }, "Failed to create staff user");
    res.status(400).json({ error: staffRequestError(error, "Unable to create staff user.") });
  }
});

router.patch("/staff/users/:userId", requireSuperAdmin, async (req, res) => {
  try {
    const actor = res.locals.staffUser as StaffUser;
    if (actor.id === req.params.userId) {
      res.status(400).json({ error: "A super admin cannot change or remove their own account here." });
      return;
    }
    const { email, password, firstName, lastName, role } = req.body as {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      role?: StaffRole;
    };
    if (email !== undefined && !email.trim()) {
      res.status(400).json({ error: "Login email cannot be empty." });
      return;
    }
    if (password !== undefined && password !== "" && password.length < 15) {
      res.status(400).json({ error: "New passwords must be at least 15 characters." });
      return;
    }
    if (role !== undefined && !["SUPER_ADMIN", "USER"].includes(role)) {
      res.status(400).json({ error: "A valid staff role is required." });
      return;
    }
    const userId = String(req.params.userId);
    const existing = await clerkClient.users.getUser(userId);
    const update: Parameters<typeof clerkClient.users.updateUser>[1] = {
      firstName,
      lastName,
      password: password || undefined,
      signOutOfOtherSessions: Boolean(password),
      publicMetadata: role ? { role } : undefined,
    };
    if (email && email.trim().toLowerCase() !== staffEmail(existing).toLowerCase()) {
      const createdEmail = await clerkClient.emailAddresses.createEmailAddress({
        userId: existing.id,
        emailAddress: email.trim().toLowerCase(),
        verified: true,
        primary: true,
      });
      update.primaryEmailAddressID = createdEmail.id;
    }
    const user = await clerkClient.users.updateUser(existing.id, update);
    await addAudit("STAFF_USER_UPDATED", "staff-users", user.id, `${staffEmail(user)} credentials or role updated`);
    res.json(serializeStaffUser(user));
  } catch (error) {
    req.log.error({ error }, "Failed to update staff user");
    res.status(400).json({ error: staffRequestError(error, "Unable to update staff user.") });
  }
});

router.delete("/staff/users/:userId", requireSuperAdmin, async (req, res) => {
  try {
    const actor = res.locals.staffUser as StaffUser;
    if (actor.id === String(req.params.userId)) {
      res.status(400).json({ error: "A super admin cannot remove their own account." });
      return;
    }
    const user = await clerkClient.users.getUser(String(req.params.userId));
    await clerkClient.users.deleteUser(user.id);
    await addAudit("STAFF_USER_REMOVED", "staff-users", user.id, `${staffEmail(user)} removed`);
    res.status(204).end();
  } catch (error) {
    req.log.error({ error }, "Failed to remove staff user");
    res.status(400).json({ error: "Unable to remove staff user." });
  }
});

const asNumber = (value: unknown) => Number(value ?? 0);
const iso = (value: Date | string | null) =>
  value instanceof Date ? value.toISOString() : value;
const calendarDate = (value: Date | string | null | undefined) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value || null;
const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
type CreateCustomerInput = ReturnType<typeof CreateCustomerBody.parse>;
type UpdateCustomerInput = ReturnType<typeof UpdateCustomerBody.parse>;
type CreatePaymentInput = ReturnType<typeof CreatePaymentBody.parse>;
type CreateRedemptionInput = ReturnType<typeof CreateRedemptionBody.parse>;

function nightBalance(allocated: number, used: number) {
  return { allocated, used, remaining: Math.max(allocated - used, 0) };
}

function customerSummary(
  customer: typeof customersTable.$inferSelect,
  membership: typeof membershipsTable.$inferSelect,
  paid: number,
) {
  return {
    id: customer.id,
    name: customer.name,
    mobile: customer.mobile,
    email: customer.email,
    city: customer.city,
    membershipId: membership.id,
    afNumber: customer.afNumber,
    product: membership.product,
    membershipStatus: customer.membershipStatus,
    totalAmount: membership.totalAmount,
    paid,
    due: Math.max(membership.totalAmount - paid, 0),
    normalNights: nightBalance(
      membership.normalNightsAllocated,
      membership.normalNightsUsed,
    ),
    offerNights: nightBalance(
      membership.offerNightsAllocated,
      membership.offerNightsUsed,
    ),
    createdAt: iso(customer.createdAt),
  };
}

async function paidForCustomer(customerId: string) {
  const rows = await db
    .select({ amount: paymentsTable.amount })
    .from(paymentsTable)
    .where(eq(paymentsTable.customerId, customerId));
  return rows.reduce((sum, payment) => sum + payment.amount, 0);
}

async function addAudit(
  action: string,
  module: string,
  recordId: string,
  detail: string,
) {
  await db.insert(auditLogsTable).values({
    id: id("AUDIT"),
    action,
    module,
    recordId,
    userName: "Staff user",
    detail,
  });
}

router.get("/dashboard/summary", async (req, res) => {
  try {
    const [customers, memberships, payments, redemptions] = await Promise.all([
      db.select().from(customersTable),
      db.select().from(membershipsTable),
      db.select().from(paymentsTable),
      db.select().from(redemptionsTable),
    ]);
    const totalValue = memberships.reduce((sum, row) => sum + row.totalAmount, 0);
    const totalCollected = payments.reduce((sum, row) => sum + row.amount, 0);
    const today = new Date().toISOString().slice(0, 10);
    const paymentsToday = payments
      .filter((payment) => payment.createdAt.toISOString().slice(0, 10) === today)
      .reduce((sum, row) => sum + row.amount, 0);
    req.log.info({ route: "dashboard-summary" }, "Dashboard summary loaded");
    res.json({
      totalCustomers: customers.length,
      activeMemberships: memberships.filter((row) => row.customerId && row).length,
      pendingMemberships: customers.filter((row) => row.membershipStatus === "PENDING").length,
      totalValue,
      totalCollected,
      outstanding: Math.max(totalValue - totalCollected, 0),
      paymentsToday,
      normalNightsRedeemed: redemptions
        .filter((row) => row.nightType === "NORMAL")
        .reduce((sum, row) => sum + row.nights, 0),
      offerNightsRedeemed: redemptions
        .filter((row) => row.nightType === "OFFER")
        .reduce((sum, row) => sum + row.nights, 0),
      hotelRedemptions: redemptions.filter((row) => row.travelType === "HOTEL").length,
      flightRedemptions: redemptions.filter((row) => row.travelType === "FLIGHT").length,
    });
  } catch (error) {
    req.log.error({ error }, "Failed to load dashboard summary");
    res.status(500).json({ error: "Unable to load dashboard summary" });
  }
});

router.get("/customers", async (req, res) => {
  try {
    const params = ListCustomersQueryParams.parse(req.query);
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 10;
    const search = params.search?.trim();
    const conditions = [];
    if (search) {
      conditions.push(
        or(
          ilike(customersTable.name, `%${search}%`),
          ilike(customersTable.mobile, `%${search}%`),
          ilike(customersTable.email, `%${search}%`),
          ilike(customersTable.city, `%${search}%`),
          ilike(customersTable.afNumber, `%${search}%`),
        ),
      );
    }
    if (params.status) {
      conditions.push(eq(customersTable.membershipStatus, params.status.toUpperCase()));
    }
    const condition = conditions.length ? and(...conditions) : undefined;
    const customerRows = await db
      .select()
      .from(customersTable)
      .where(condition)
      .orderBy(desc(customersTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRows = await db.select({ count: sql<number>`count(*)` }).from(customersTable).where(condition);
    const items = await Promise.all(
      customerRows.map(async (customer) => {
        const [membership] = await db
          .select()
          .from(membershipsTable)
          .where(eq(membershipsTable.customerId, customer.id))
          .limit(1);
        const paid = await paidForCustomer(customer.id);
        return membership ? customerSummary(customer, membership, paid) : null;
      }),
    );
    res.json({ items: items.filter(Boolean), page, pageSize, total: Number(totalRows[0]?.count ?? 0) });
  } catch (error) {
    req.log.error({ error }, "Failed to list customers");
    res.status(400).json({ error: "Unable to list customers" });
  }
});

router.post("/customers", async (req, res) => {
  try {
    const input = CreateCustomerBody.parse(req.body) as CreateCustomerInput;
    const customerId = id("CE");
    const membershipId = id("MEM");
    const normalNightsAllocated = input.tenureYears * 7;
    const result = await db.transaction(async (tx) => {
      const [customer] = await tx
        .insert(customersTable)
        .values({
          id: customerId,
          name: input.name,
          mobile: input.mobile,
          email: input.email,
          city: input.city,
          afNumber: input.afNumber || null,
          dateOfBirth: calendarDate(input.dateOfBirth),
          gender: input.gender || null,
          relation: input.relation || null,
          address: input.address || null,
        })
        .returning();
      const [membership] = await tx
        .insert(membershipsTable)
        .values({
          id: membershipId,
          customerId,
          product: input.product,
          tenureYears: input.tenureYears,
          totalAmount: input.totalAmount,
          normalNightsAllocated,
          offerNightsAllocated: input.offerNights,
        })
        .returning();
      const initialPayment = input.initialPayment ?? 0;
      if (initialPayment > 0) {
        await tx.insert(paymentsTable).values({
          id: id("PAY"),
          customerId,
          membershipId,
          receiptNumber: `CE-${Date.now()}`,
          amount: initialPayment,
          previouslyPaid: 0,
          totalPaid: initialPayment,
          remainingDue: Math.max(input.totalAmount - initialPayment, 0),
          method: input.paymentMethod || "Other",
        });
      }
      await tx.insert(auditLogsTable).values([
        { id: id("AUDIT"), action: "CUSTOMER_SUBMITTED", module: "customers", recordId: customerId, userName: "Staff user", detail: `${input.name} submitted` },
        { id: id("AUDIT"), action: "MEMBERSHIP_CREATED", module: "memberships", recordId: membershipId, userName: "Staff user", detail: `${input.product}, ${normalNightsAllocated} normal nights, ${input.offerNights} offer nights` },
      ]);
      return { customer, membership };
    });
    res.status(201).json(customerSummary(result.customer, result.membership, input.initialPayment ?? 0));
  } catch (error) {
    req.log.error({ error }, "Failed to create customer");
    res.status(400).json({ error: "Unable to create customer" });
  }
});

router.get("/customers/:customerId", async (req, res) => {
  try {
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, req.params.customerId));
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const [membership] = await db.select().from(membershipsTable).where(eq(membershipsTable.customerId, customer.id)).limit(1);
    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const [payments, redemptions] = await Promise.all([
      db.select().from(paymentsTable).where(eq(paymentsTable.customerId, customer.id)).orderBy(desc(paymentsTable.createdAt)),
      db.select().from(redemptionsTable).where(eq(redemptionsTable.customerId, customer.id)).orderBy(desc(redemptionsTable.createdAt)),
    ]);
    const paid = payments.reduce((sum, payment) => sum + payment.amount, 0);
    res.json({
      ...customerSummary(customer, membership, paid),
      dateOfBirth: customer.dateOfBirth,
      gender: customer.gender,
      relation: customer.relation,
      address: customer.address,
      family: [],
      nominees: [],
      payments: payments.map((payment) => ({
        id: payment.id,
        receiptNumber: payment.receiptNumber,
        paymentDate: iso(payment.createdAt),
        amount: payment.amount,
        previouslyPaid: payment.previouslyPaid,
        totalPaid: payment.totalPaid,
        remainingDue: payment.remainingDue,
        method: payment.method,
        reference: payment.reference,
        createdBy: payment.createdBy,
      })),
      redemptions: redemptions.map((redemption) => ({
        id: redemption.id,
        nightType: redemption.nightType,
        nights: redemption.nights,
        travelType: redemption.travelType,
        status: redemption.status,
        hotelName: redemption.hotelName,
        city: redemption.city,
        checkIn: redemption.checkIn,
        checkOut: redemption.checkOut,
        hotelNights: redemption.hotelNights,
        costPerNight: redemption.costPerNight,
        totalHotelCost: redemption.totalHotelCost,
        createdAt: iso(redemption.createdAt),
      })),
    });
  } catch (error) {
    req.log.error({ error }, "Failed to load customer");
    res.status(500).json({ error: "Unable to load customer" });
  }
});

router.patch("/customers/:customerId", async (req, res) => {
  try {
    const input = UpdateCustomerBody.parse(req.body) as UpdateCustomerInput;
    const [customer] = await db
      .update(customersTable)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(customersTable.id, req.params.customerId))
      .returning();
    if (!customer) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const [membership] = await db.select().from(membershipsTable).where(eq(membershipsTable.customerId, customer.id)).limit(1);
    const paid = await paidForCustomer(customer.id);
    await addAudit("CUSTOMER_UPDATED", "customers", customer.id, "Customer details updated");
    res.json(customerSummary(customer, membership, paid));
  } catch (error) {
    req.log.error({ error }, "Failed to update customer");
    res.status(400).json({ error: "Unable to update customer" });
  }
});

router.post("/customers/:customerId/payments", async (req, res) => {
  try {
    const input = CreatePaymentBody.parse(req.body) as CreatePaymentInput;
    const [membership] = await db.select().from(membershipsTable).where(eq(membershipsTable.customerId, req.params.customerId)).limit(1);
    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const previous = await paidForCustomer(req.params.customerId);
    const due = Math.max(membership.totalAmount - previous, 0);
    if (input.amount > due) {
      res.status(400).json({ error: "Payment exceeds outstanding amount." });
      return;
    }
    const payment = {
      id: id("PAY"),
      customerId: req.params.customerId,
      membershipId: membership.id,
      receiptNumber: `CE-${Date.now()}`,
      amount: input.amount,
      previouslyPaid: previous,
      totalPaid: previous + input.amount,
      remainingDue: Math.max(due - input.amount, 0),
      method: input.method,
      reference: input.reference || null,
      remarks: input.remarks || null,
      createdBy: "Staff user",
    };
    const [created] = await db.insert(paymentsTable).values(payment).returning();
    await addAudit("PAYMENT_CREATED", "payments", created.id, `${created.receiptNumber} for ₹${created.amount.toLocaleString("en-IN")}`);
    await addAudit("RECEIPT_GENERATED", "receipts", created.receiptNumber, "Receipt ready to download");
    res.status(201).json({
      id: created.id,
      receiptNumber: created.receiptNumber,
      paymentDate: iso(created.createdAt),
      amount: created.amount,
      previouslyPaid: created.previouslyPaid,
      totalPaid: created.totalPaid,
      remainingDue: created.remainingDue,
      method: created.method,
      reference: created.reference,
      createdBy: created.createdBy,
    });
  } catch (error) {
    req.log.error({ error }, "Failed to create payment");
    res.status(400).json({ error: "Unable to create payment" });
  }
});

router.post("/customers/:customerId/redemptions", async (req, res) => {
  try {
    const input = CreateRedemptionBody.parse(req.body) as CreateRedemptionInput;
    const [membership] = await db.select().from(membershipsTable).where(eq(membershipsTable.customerId, req.params.customerId)).limit(1);
    if (!membership) {
      res.status(404).json({ error: "Membership not found" });
      return;
    }
    const nightType = input.nightType === "OFFER" ? "OFFER" : "NORMAL";
    const used = nightType === "OFFER" ? membership.offerNightsUsed : membership.normalNightsUsed;
    const allocated = nightType === "OFFER" ? membership.offerNightsAllocated : membership.normalNightsAllocated;
    const available = allocated - used;
    if (input.nights > available) {
      res.status(400).json({ error: `Only ${available} ${nightType.toLowerCase()} nights are currently available.` });
      return;
    }
    let hotelNights: number | null = null;
    let totalHotelCost: number | null = null;
    if (input.travelType === "HOTEL") {
      if (!input.checkIn || !input.checkOut || !input.hotelName) {
        res.status(400).json({ error: "Hotel name, check-in, and check-out are required." });
        return;
      }
      const start = new Date(`${input.checkIn}T00:00:00Z`);
      const end = new Date(`${input.checkOut}T00:00:00Z`);
      hotelNights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
      if (hotelNights <= 0) {
        res.status(400).json({ error: "Check-out must be after check-in." });
        return;
      }
      totalHotelCost = hotelNights * (input.costPerNight ?? 0);
    }
    const redemption = {
      id: id("HR"),
      customerId: req.params.customerId,
      membershipId: membership.id,
      nightType,
      nights: input.nights,
      travelType: input.travelType,
      hotelName: input.hotelName || null,
      city: input.city || null,
      checkIn: calendarDate(input.checkIn),
      checkOut: calendarDate(input.checkOut),
      hotelNights,
      costPerNight: input.costPerNight ?? null,
      totalHotelCost,
      roomNumber: input.roomNumber || null,
      createdBy: "Staff user",
    };
    const [created] = await db.transaction(async (tx) => {
      const [saved] = await tx.insert(redemptionsTable).values(redemption).returning();
      await tx.update(membershipsTable).set(
        nightType === "OFFER"
          ? { offerNightsUsed: membership.offerNightsUsed + input.nights, updatedAt: new Date() }
          : { normalNightsUsed: membership.normalNightsUsed + input.nights, updatedAt: new Date() },
      ).where(eq(membershipsTable.id, membership.id));
      await tx.insert(auditLogsTable).values([
        { id: id("AUDIT"), action: `${input.travelType}_REDEMPTION_CREATED`, module: "redemptions", recordId: saved.id, userName: "Staff user", detail: `${input.nights} ${nightType.toLowerCase()} nights` },
        { id: id("AUDIT"), action: "NIGHT_REDEEMED", module: "night-ledger", recordId: saved.id, userName: "Staff user", detail: `${available} before, ${available - input.nights} remaining` },
      ]);
      return [saved] as const;
    });
    res.status(201).json({
      id: created.id,
      nightType: created.nightType,
      nights: created.nights,
      travelType: created.travelType,
      status: created.status,
      hotelName: created.hotelName,
      city: created.city,
      checkIn: created.checkIn,
      checkOut: created.checkOut,
      hotelNights: created.hotelNights,
      costPerNight: created.costPerNight,
      totalHotelCost: created.totalHotelCost,
      createdAt: iso(created.createdAt),
    });
  } catch (error) {
    req.log.error({ error }, "Failed to create redemption");
    res.status(400).json({ error: "Unable to create redemption" });
  }
});

router.get("/audit", async (req, res) => {
  try {
    const { limit } = ListAuditLogsQueryParams.parse(req.query);
    const logs = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.timestamp)).limit(limit ?? 20);
    res.json(logs.map((log) => ({ ...log, timestamp: iso(log.timestamp) })));
  } catch (error) {
    req.log.error({ error }, "Failed to list audit logs");
    res.status(400).json({ error: "Unable to list audit logs" });
  }
});

export default router;