import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { prisma } from "../lib/database";
import { oauthConfig } from "./oauth";
import { logger } from "../lib/logger";
import bcrypt from "bcryptjs";

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
logger.info("Configurando Google OAuth strategy...");
logger.info(`Client ID: ${oauthConfig.google.clientID ? "Presente" : "FALTANTE"}`);
logger.info(`Client Secret: ${oauthConfig.google.clientSecret ? "Presente" : "FALTANTE"}`);
logger.info(`Callback URL: ${oauthConfig.google.callbackURL}`);
logger.info(`Scope: ${oauthConfig.google.scope}`);

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
      async (accessToken, refreshToken, profile, done) => {
        try {
          logger.info("=== GOOGLE OAUTH STRATEGY CALLBACK INICIADO ===");
          logger.info("Google OAuth strategy callback executed");
          logger.info(`Profile: ${JSON.stringify(profile, null, 2)}`);
          logger.info(`Access token: ${accessToken ? "Present" : "Missing"}`);
          logger.info(`Refresh token: ${refreshToken ? "Present" : "Missing"}`);
          logger.info(
            `Google OAuth callback for user: ${profile.emails?.[0]?.value}`,
          );

          if (!profile.emails || !profile.emails[0]) {
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
              logger.warn(`Intento de login con dominio no permitido: ${email}`);
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

            logger.info(`Existing user logged in via Google: ${user.email}`);
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

          logger.info(`New user created via Google OAuth: ${newUser.email}`);
          return done(null, newUser);
        } catch (error) {
          logger.error(error, "Error in Google OAuth strategy:");
          return done(error, null);
        }
      },
    ),
  );
  logger.info("Google OAuth strategy configurada exitosamente");
} else {
  logger.warn("Google OAuth no configurado - faltan credenciales");
}

export default passport;
