import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
    __amcPrisma?: PrismaClient;
};

export const prisma = globalForPrisma.__amcPrisma ?? new PrismaClient({
    log: process.env.NODE_ENV !== "production" ? ["query", "error", "warn"] : ["error"],
});

if (!globalForPrisma.__amcPrisma) {
    globalForPrisma.__amcPrisma = prisma;
}
