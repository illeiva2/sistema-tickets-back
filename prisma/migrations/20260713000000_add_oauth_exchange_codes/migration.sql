-- CreateTable
CREATE TABLE "oauth_exchange_codes" (
    "id" TEXT NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_exchange_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_exchange_codes_codeHash_key" ON "oauth_exchange_codes"("codeHash");

-- CreateIndex
CREATE INDEX "oauth_exchange_codes_expiresAt_idx" ON "oauth_exchange_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "oauth_exchange_codes_userId_idx" ON "oauth_exchange_codes"("userId");

-- AddForeignKey
ALTER TABLE "oauth_exchange_codes" ADD CONSTRAINT "oauth_exchange_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
