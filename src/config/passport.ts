import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { prisma } from "../lib/database";
import { oauthConfig } from "./oauth";
import { logger } from "../lib/logger";
import bcrypt from "bcryptjs";

const googleLogContext = { provider: "google" } as const;

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

          const email = profile.emails[0].value;

          // Validar el dominio de la empresa
          if (oauthConfig.google.allowedDomains && oauthConfig.google.allowedDomains.length > 0) {
            const isAllowed = oauthConfig.google.allowedDomains.some((domain) =>
              email.endsWith(`@${domain.trim()}`)
            );
            
            if (!isAllowed) {
              logger.warn(
                { ...googleLogContext, outcome: "domain_not_allowed" },
                "OAuth profile rejected",
              );
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return done(new Error(`Acceso denegado. Solo se permiten los dominios: ${oauthConfig.google.allowedDomains.join(", ")}`), false as any);
            }
          }
          const googleId = profile.id;
          const name =
            profile.displayName || profile.name?.givenName || "Usuario";

          // Buscar usuario existente por email o googleId
          const user = await prisma.user.findFirst({
            where: {
              OR: [
                { email },
                { googleId }
              ]
            },
          });

          if (user) {
            // Usuario existe, actualizar información de Google si es necesario
            const updateData: any = {};
            if (!user.googleId) {
              updateData.googleId = googleId;
            }
            if (user.email !== email) {
              updateData.email = email;
            }

            if (Object.keys(updateData).length > 0) {
              await prisma.user.update({
                where: { id: user.id },
                data: updateData,
              });
            }

            logger.info(
              {
                ...googleLogContext,
                outcome: "existing_user",
                userId: user.id,
                role: user.role,
              },
              "OAuth authentication succeeded",
            );
            return done(null, user);
          }

          // Crear nuevo usuario
          const newUser = await prisma.user.create({
            data: {
              email,
              name,
              googleId,
              passwordHash: await bcrypt.hash(Math.random().toString(36), 12), // Contraseña aleatoria
              role: "USER", // Rol por defecto
            },
          });

          // Crear preferencias de notificación por defecto
          await prisma.notificationPreferences.create({
            data: {
              userId: newUser.id,
              email: true,
              inApp: true,
              ticketAssigned: true,
              statusChanged: true,
              commentAdded: true,
              priorityChanged: true,
            },
          });

          logger.info(
            {
              ...googleLogContext,
              outcome: "new_user",
              userId: newUser.id,
              role: newUser.role,
            },
            "OAuth authentication succeeded",
          );
          return done(null, newUser);
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
