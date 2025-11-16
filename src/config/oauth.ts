export const oauthConfig = {
  google: {
    clientID: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    callbackURL:
      process.env.GOOGLE_CALLBACK_URL ||
      (process.env.NODE_ENV === "production" 
        ? `${process.env.API_URL || "http://localhost:3001"}/api/auth/google/callback`
        : "http://localhost:3001/api/auth/google/callback"),
    scope: ["profile", "email"],
  },
  jwt: {
    secret: process.env.JWT_SECRET || "your-jwt-secret",
    expiresIn: process.env.JWT_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },
  session: {
    secret: process.env.SESSION_SECRET || "your-session-secret",
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  },
};

export const validateOAuthConfig = () => {
  const required = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required OAuth environment variables: ${missing.join(", ")}`,
    );
  }

  return true;
};
