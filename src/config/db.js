const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Connect helper for startup check
async function connectDB() {
    await prisma.$connect();
    console.log("✅ Successfully connected to MongoDB via Prisma Client");
    return prisma;
}

module.exports = {
    prisma,
    connectDB
};
