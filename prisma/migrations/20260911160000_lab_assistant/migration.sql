-- Asistente de laboratorio: consultas de usuarios, turnos del modelo que ejecuta
-- el relé del molino, y presencia del relé. Aditivo: tablas nuevas.

CREATE TABLE "lab_assistant_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "question" TEXT NOT NULL,
    "messages" JSONB NOT NULL,
    "answer" TEXT,
    "toolTrace" JSONB,
    "error" TEXT,
    "model" TEXT,
    "steps" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "lab_assistant_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lab_assistant_jobs" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "claimedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "lab_assistant_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "lab_assistant_relays" (
    "slug" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "model" TEXT,
    "info" JSONB,

    CONSTRAINT "lab_assistant_relays_pkey" PRIMARY KEY ("slug")
);

CREATE INDEX "lab_assistant_requests_userId_createdAt_idx" ON "lab_assistant_requests"("userId", "createdAt");
CREATE INDEX "lab_assistant_requests_status_createdAt_idx" ON "lab_assistant_requests"("status", "createdAt");
CREATE INDEX "lab_assistant_jobs_status_createdAt_idx" ON "lab_assistant_jobs"("status", "createdAt");

ALTER TABLE "lab_assistant_requests" ADD CONSTRAINT "lab_assistant_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lab_assistant_jobs" ADD CONSTRAINT "lab_assistant_jobs_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "lab_assistant_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
