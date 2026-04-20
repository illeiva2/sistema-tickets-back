# Sistema de Tickets - Documentación General

Esta documentación sirve como guía base para el desarrollo, mantenimiento y entendimiento de las funcionalidades de la aplicación "Sistema de Tickets".

## 1. Descripción General del Proyecto

El sistema es una plataforma completa de gestión de tickets que permite a los usuarios crear solicitudes, a los agentes gestionarlas, y a los administradores supervisar todo el flujo de trabajo. Adicionalmente, cuenta con un robusto sistema de organización de archivos anexos y notificaciones en tiempo real.

El proyecto está dividido en dos grandes bloques:
- **Frontend (`sistema-tickets-web`)**: Aplicación del lado del cliente construida con React.
- **Backend (`sistema-tickets-api`)**: API RESTful construida con Node.js y Express.

---

## 2. Pila Tecnológica (Tech Stack)

### Backend (API)
- **Entorno de Ejecución**: Node.js (>= 18.0)
- **Framework**: Express.js con TypeScript.
- **Base de Datos & ORM**: PostgreSQL, gestionado mediante **Prisma ORM**.
- **Autenticación**: JSON Web Tokens (JWT) y Google OAuth 2.0 (`passport-google-oauth20`).
- **Validación de Datos**: Zod.
- **Gestión de Archivos**: Multer y Cloudinary (almacenamiento en la nube).
- **Procesamiento de Imágenes y PDFs**: `sharp` y `pdf-lib`.
- **Correo y Notificaciones**: Nodemailer para envíos de emails.
- **Logs**: Pino logger.

### Frontend (Web)
- **Librería Core**: React 18 con Vite.
- **Lenguaje**: TypeScript.
- **Estilos**: Tailwind CSS, Class Variance Authority (`cva`), `clsx` y `tailwind-merge`.
- **Gestión de Estado y Fetching**: React Query (`@tanstack/react-query`) y Axios.
- **Enrutamiento**: React Router DOM v6.
- **Formularios**: React Hook Form con `zod` resolver.
- **Componentes Visuales**: Recharts (para gráficos en dashboard), Lucide React (íconos) y React Hot Toast (notificaciones UI).
- **Manejo de Fechas**: `date-fns`.

---

## 3. Arquitectura y Modelo de Datos

La aplicación se apoya en una base de datos relacional modelada con Prisma. Las entidades principales incluyen:

- **Users**: Usuarios del sistema. Existen 3 roles principales: `USER`, `AGENT`, y `ADMIN`.
- **Tickets**: El núcleo del sistema. Poseen estado (`OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`), prioridad (`LOW`, `MEDIUM`, `HIGH`, `URGENT`), y están asignados a un solicitante y un agente.
- **Comments**: Mensajes de seguimiento vinculados a un ticket y un usuario autor.
- **Attachments**: Archivos adjuntos a un ticket con metadatos sobre tamaño y ubicación en Cloudinary.
- **Organización de Archivos**: Incluye entidades como `FileCategory`, `FileTag`, y `FileOrganization` para categorizar globalmente los anexos.
- **Logs y Notificaciones**: `AuditLog` para rastrear cambios y `Notification` / `NotificationPreferences` para avisos interactivos.

---

## 4. Funcionalidades Principales

1. **Gestión Integral de Tickets**: Creación de tickets, reasignación, cambios de estado y control de prioridad.
2. **Sistema de Comentarios y Archivos**: Soporte para agregar múltiples comentarios y adjuntar archivos subidos directamente a Cloudinary.
3. **Autenticación OAuth y Local**: Inicio de sesión mixto.
4. **Organización Avanzada de Documentos**: Clasificación de archivos mediante etiquetas (tags) y categorías.
5. **Auditoría e Historial**: Registro detallado de qué usuario ejecutó qué acción (creación, edición, borrado de entidades).

---

## 5. Control de Versiones Actual

El código actualmente está versionado utilizando Git.  
**Backend (`sistema-tickets-back`)**:
- **Último Commit**: `18516dcd3d66247b1ea2df4d71c915dcee26580`
- **Autor**: illeiva2 (Wed Apr 1 15:49:38 2026 -0300)
- **Mensaje**: *evitar error P3005 en produccion*

*El Frontend sigue la misma convención de control de base, utilizando la estructura generada por Vite (v1.0.0 en package.json).*

---

## 6. Siguientes Pasos Operativos

- **Backend**: `npm run dev` levantará el servidor utilizando `tsx`.
- **Base de Datos**: Se puede levantar un entorno local mediante `npm run db:up` (requiere Docker). Para sincronizar la base: `npm run db:migrate:dev`.
- **Frontend**: `npm run dev` iniciará la aplicación de React.
