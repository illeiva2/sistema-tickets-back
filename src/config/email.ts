import nodemailer from "nodemailer";
import { config } from "./index";

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

// Configuración del transportador de email
export const createTransporter = () => {
  const emailConfig: EmailConfig = {
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.password,
    },
  };

  return nodemailer.createTransport(emailConfig);
};

// Verificar conexión del email
export const verifyEmailConnection = async () => {
  try {
    const transporter = createTransporter();
    await transporter.verify();
    console.log("✅ Email service connection verified");
    return true;
  } catch (error) {
    console.error("❌ Email service connection failed:", error);
    return false;
  }
};
