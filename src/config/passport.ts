import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { prisma } from "../lib/database";
import { oauthConfig } from "./oauth";
import { logger } from "../lib/logger";

const googleLogContext = { provider: "google" } as const;

const oauthAccessError = (code: string) => {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
};

const getSafeCallbackTarget = (callbackURL: string) => {
  try {
    const url = new URL(callbackURL);
    return { callbackOrigin: url.origin, callbackPath: url.pathname };
  } catch {
    return { callbackOrigin: "invalid", callbackPath: "invalid" };
  }
};

// Serializar usuario para la sesión
passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

// Deserializar usuario de la sesión
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// Estrategia de Google OAuth
logger.info(
  {
    ...googleLogContext,
    clientConfigured: Boolean(oauthConfig.google.clientID),
    secretConfigured: Boolean(oauthConfig.google.clientSecret),
    ...getSafeCallbackTarget(oauthConfig.google.callbackURL),
    scope: oauthConfig.google.scope,
  },
  "Configuring OAuth strategy",
);

// Solo configurar Google OAuth si las credenciales están disponibles
if (oauthConfig.google.clientID && oauthConfig.google.clientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: oauthConfig.google.clientID,
        clientSecret: oauthConfig.google.clientSecret,
        callbackURL: oauthConfig.google.callbackURL,
        scope: oauthConfig.google.scope,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          logger.info(
            { ...googleLogContext, stage: "verify_callback" },
            "OAuth strategy callback received",
          );

          if (!profile.emails || !profile.emails[0]) {
            logger.warn(
              { ...googleLogContext, outcome: "missing_email" },
              "OAuth profile rejected",
            );
            // passport tipa el segundo arg de done() como User; null/false son
            // valores válidos en runtime pero TS no lo modela.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return done(new Error("No email provided by Google"), null as any);
          }

          const email = profile.emails[0].value.trim().toLowerCase();

          // Validar el dominio de la empresa
          if (
            oauthConfig.google.allowedDomains &&
            oauthConfig.google.allowedDomains.length > 0
          ) {
            const emailDomain = email.split("@").at(-1);
            const isAllowed = oauthConfig.google.allowedDomains.some(
              (domain) => emailDomain === domain.trim().toLowerCase(),
            );

            if (!isAllowed) {
              logger.warn(
                { ...googleLogContext, outcome: "domain_not_allowed" },
                "OAuth profile rejected",
              );
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return done(oauthAccessError("domain_not_allowed"), false as any);
            }
          }
          const googleId = profile.id;

          // Google Workspace se habilita sólo para cuentas IT ya
          // provisionadas. El dominio por sí solo no concede acceso.
          const googleUser = await prisma.user.findUnique({
            where: { googleId },
          });
          const emailUser = await prisma.user.findFirst({
            where: {
              email: { equals: email, mode: "insensitive" },
            },
          });
          const identityConflict =
            (googleUser && emailUser && googleUser.id !== emailUser.id) ||
            (emailUser?.googleId && emailUser.googleId !== googleId);

          if (identityConflict) {
            logger.warn(
              { ...googleLogContext, outcome: "identity_mismatch" },
              "OAuth profile rejected",
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return done(oauthAccessError("it_access_required"), false as any);
          }

          const user = googleUser || emailUser;

          if (!user || (user.role !== "AGENT" && user.role !== "ADMIN")) {
            logger.warn(
              { ...googleLogContext, outcome: "it_access_required" },
              "OAuth profile rejected",
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return done(oauthAccessError("it_access_required"), false as any);
          }

          if (user.isActive === false || user.deletedAt) {
            logger.warn(
              { ...googleLogContext, outcome: "account_disabled" },
              "OAuth profile rejected",
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return done(oauthAccessError("account_disabled"), false as any);
          }

          // Vincular el Google ID verificado y normalizar el correo si hace
          // falta, sin permitir que Google modifique rol ni estado.
          const updateData: { googleId?: string; email?: string } = {};
          if (!user.googleId) updateData.googleId = googleId;
          if (user.email !== email) updateData.email = email;

          const authenticatedUser =
            Object.keys(updateData).length > 0
              ? await prisma.user.update({
                  where: { id: user.id },
                  data: updateData,
                })
              : user;

          logger.info(
            {
              ...googleLogContext,
              outcome: "existing_it_user",
              userId: authenticatedUser.id,
              role: authenticatedUser.role,
            },
            "OAuth authentication succeeded",
          );
          return done(null, authenticatedUser);
        } catch (error) {
          logger.error(
            {
              ...googleLogContext,
              errorType: error instanceof Error ? error.name : typeof error,
            },
            "OAuth strategy callback failed",
          );
          return done(error, null);
        }
      },
    ),
  );
  logger.info(googleLogContext, "OAuth strategy configured");
} else {
  logger.warn(googleLogContext, "OAuth strategy disabled: missing configuration");
}

export default passport;
