require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, { tls: true });

let bookings;

// ✅ Connect to MongoDB Atlas before starting server
async function startServer() {
  try {
    await client.connect();
    const db = client.db("hotel_devang");
    bookings = db.collection("bookings");
    console.log("✅ Connected to MongoDB Atlas");

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

// ✅ Default route for Render health check
app.get('/', (req, res) => {
  res.send("Hotel Devang Booking API is running ✅");
});

// ✅ GET all bookings (for debugging / avoid Cannot GET)
app.get('/api/book', async (req, res) => {
  if (!bookings) {
    return res.status(503).json({ success: false, error: "DB not ready" });
  }

  try {
    const allBookings = await bookings.find().toArray();
    res.status(200).json({ success: true, data: allBookings });
  } catch (err) {
    console.error("❌ Error fetching bookings:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ POST a new booking
app.post('/api/book', async (req, res) => {
  console.log("📥 Received booking request:", req.body);

  if (!bookings) {
    console.error("❌ bookings collection not ready yet");
    return res.status(503).json({ success: false, error: 'Server initializing, try again' });
  }

  try {
    const bookingData = {
      guest_name: req.body.guest_name,
      contact: req.body.email,
      check_in: req.body.check_in,
      check_out: req.body.check_out,
      room_type: req.body.room_type,
      message: req.body.message,
      timestamp: new Date()
    };

    const result = await bookings.insertOne(bookingData);
    console.log("✅ Booking saved:", result.insertedId);
    res.status(200).json({ success: true, id: result.insertedId });
  } catch (err) {
    console.error("❌ Error saving booking:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

startServer();
