const { MongoClient } = require('mongodb');

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error("❌ MONGO_URI is missing in .env file");
    process.exit(1);
}

// Enable TLS for MongoDB Atlas connection as in the original server.js
const client = new MongoClient(uri, { tls: true });

let dbInstance = null;

/**
 * Connect to MongoDB Atlas
 */
async function connectDB() {
    if (dbInstance) return dbInstance;
    
    try {
        console.log("🔌 Connecting to MongoDB Atlas...");
        await client.connect();
        dbInstance = client.db("hotel_devang");
        console.log("✅ Successfully connected to MongoDB Atlas via shared DB module");
        return dbInstance;
    } catch (error) {
        console.error("❌ MongoDB Atlas connection failed in shared DB module:", error);
        throw error;
    }
}

/**
 * Get active DB instance
 */
function getDB() {
    if (!dbInstance) {
        throw new Error("Database not initialized. Call connectDB first.");
    }
    return dbInstance;
}

/**
 * Helper to get a collection
 * @param {string} collectionName 
 */
function getCollection(collectionName) {
    return getDB().collection(collectionName);
}

module.exports = {
    connectDB,
    getDB,
    getCollection,
    client
};
