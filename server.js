require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();

// ✅ Allow only your website frontend to access the API
app.use(cors({
    origin: [
        "https://hoteldevang.com",
        "https://www.hoteldevang.com"
    ],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// ✅ MongoDB setup
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { tls: true });
let bookings;

// ✅ Connect to MongoDB
async function startServer() {
    try {
        await client.connect();
        const db = client.db("hotel_devang");
        bookings = db.collection("bookings");
        console.log("✅ Connected to MongoDB Atlas");

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
    } catch (err) {
        console.error("❌ MongoDB connection failed:", err);
        process.exit(1);
    }
}

// ✅ Health check
app.get('/', (req, res) => {
    res.send("Hotel Devang Booking API is running ✅");
});

// ✅ Get all bookings (for debugging)
app.get('/api/book', async (req, res) => {
    if (!bookings) return res.status(503).json({ success: false, error: "DB not ready" });
    try {
        const allBookings = await bookings.find().toArray();
        res.status(200).json({ success: true, data: allBookings });
    } catch (err) {
        console.error("❌ Error fetching bookings:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ✅ Handle booking submission (NO reCAPTCHA)
app.post('/api/book', async (req, res) => {
    console.log("📥 Received booking request:", req.body);

    if (!bookings)
        return res.status(503).json({ success: false, error: 'Server initializing, try again' });

    try {
        const { guest_name, phone, check_in, check_out, room_type, message } = req.body;

        // ✅ Basic validation
        if (!guest_name || !phone || !check_in || !check_out || !room_type) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        const bookingData = {
            guest_name,
            contact: phone,
            check_in,
            check_out,
            room_type,
            message: message || "None",
            timestamp: new Date()
        };

        // ✅ Prevent duplicate bookings
        const existing = await bookings.findOne({
            guest_name: bookingData.guest_name,
            contact: bookingData.contact,
            check_in: bookingData.check_in,
            check_out: bookingData.check_out,
            room_type: bookingData.room_type
        });

        if (existing) {
            console.log("⚠️ Duplicate booking ignored");
            return res.status(200).json({ success: false, message: "Duplicate booking" });
        }

        // ✅ Save booking to MongoDB
        const result = await bookings.insertOne(bookingData);
        console.log("✅ Booking saved:", result.insertedId);

        res.status(200).json({ success: true, id: result.insertedId });
    } catch (err) {
        console.error("❌ Error saving booking:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

startServer();
