import jwt from "jsonwebtoken";

// Helpers de autenticación: generar tokens válidos para los tests.
export const signAccessToken = (
  overrides: Partial<{
    id: string;
    email: string;
    role: "USER" | "AGENT" | "ADMIN";
    mustChangePassword: boolean;
  }> = {},
) => {
  return jwt.sign(
    {
      id: overrides.id ?? "user-1",
      email: overrides.email ?? "user@test.local",
      role: overrides.role ?? "USER",
      mustChangePassword: overrides.mustChangePassword ?? false,
    },
    process.env.JWT_SECRET!,
    { expiresIn: "1h" },
  );
};

export const signRefreshToken = (id = "user-1") => {
  return jwt.sign({ id, type: "refresh" }, process.env.JWT_SECRET!, {
    expiresIn: "7d",
  });
};

// Factories de objetos mock. Cada test puede pasar overrides.
export const makeUser = (overrides: Partial<any> = {}) => ({
  id: "user-1",
  email: "user@test.local",
  passwordHash: "hashed",
  name: "Test User",
  role: "USER" as const,
  googleId: null,
  mustChangePassword: false,
  isActive: true,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

export const makeTicket = (overrides: Partial<any> = {}) => ({
  id: "ticket-1",
  ticketNumber: 1,
  title: "Test ticket",
  description: "Test desc",
  status: "OPEN" as const,
  priority: "MEDIUM" as const,
  category: null,
  isRead: false,
  requesterId: "user-1",
  assigneeId: null,
  closedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  requester: { id: "user-1", name: "Test User", email: "user@test.local" },
  assignee: null,
  ...overrides,
});

export const makeAgent = (overrides: Partial<any> = {}) =>
  makeUser({
    id: "agent-1",
    email: "agent@test.local",
    name: "Test Agent",
    role: "AGENT",
    ...overrides,
  });

export const makeAdmin = (overrides: Partial<any> = {}) =>
  makeUser({
    id: "admin-1",
    email: "admin@test.local",
    name: "Test Admin",
    role: "ADMIN",
    ...overrides,
  });
