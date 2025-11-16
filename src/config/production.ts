import { config } from './index';

// Configuración específica para producción
export const productionConfig = {
  ...config,
  
  // Configuración de CORS para producción
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      process.env.FRONTEND_URLS?.split(',')[0] || 'https://yourdomain.com'
    ],
    credentials: true,
    optionsSuccessStatus: 200
  },

  // Configuración de rate limiting más estricta en producción
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutos
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'), // máximo 100 requests por ventana
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Demasiadas solicitudes, intenta de nuevo más tarde'
      }
    }
  },

  // Configuración de seguridad adicional
  security: {
    helmet: {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"]
        }
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }
  },

  // Configuración de logging para producción
  logging: {
    level: 'info',
    prettyPrint: false,
    redact: ['password', 'token', 'secret']
  },

  // Configuración de base de datos para producción
  database: {
    connectionLimit: 10,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
  },

  // Configuración de archivos para producción
  fileUpload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB
    allowedMimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ],
    storage: process.env.FILE_STORAGE || 'local' // Configurar con FILE_STORAGE env var
  },

  // Configuración de OAuth para producción
  oauth: {
    google: {
      callbackURL: process.env.GOOGLE_CALLBACK_URL || `${process.env.API_URL || 'https://api.yourdomain.com'}/auth/google/callback`,
      scope: ['profile', 'email']
    }
  },

  // Configuración de email para producción
  email: {
    service: 'sendgrid', // o 'resend', 'mailgun', etc.
    from: process.env.EMAIL_FROM || 'noreply@yourdomain.com',
    retryAttempts: 3,
    retryDelay: 1000
  },

  // Configuración de monitoreo
  monitoring: {
    enabled: true,
    sentry: {
      dsn: process.env.SENTRY_DSN,
      environment: 'production'
    },
    healthCheck: {
      enabled: true,
      interval: 30000, // 30 segundos
      timeout: 5000
    }
  }
};

export default productionConfig;
