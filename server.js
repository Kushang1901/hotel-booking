require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Mongo URI from environment variables
const uri = process.env.MONGO_URI;

// ✅ Use MongoClient without deprecated options
const client = new MongoClient(uri, { tls: true });

let bookings;

// ✅ Connect to MongoDB Atlas
client.connect()
  .then(() => {
    const db = client.db("hotel_devang");
    bookings = db.collection("bookings");
    console.log("✅ Connected to MongoDB Atlas");
  })
  .catch(err => {
    console.error("❌ MongoDB connection failed:", err.stack);
  });

// 🏠 Root route to check service health
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Hotel Devang Backend is running 🚀" });
});

// 📌 Booking API
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
    res.status(200).json({ success: true, bookingId: result.insertedId });
  } catch (err) {
    console.error("❌ Error saving booking:", err.stack);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ PORT must come from Render (dynamic) or fallback for local dev
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
