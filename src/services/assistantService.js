require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const { prisma } = require('../config/db');

const DEFAULT_COUNTS = {
  Standard: 2,
  Deluxe: 31,
  'Super Deluxe': 8,
  Suite: 2,
};

const DEFAULT_DETAILS = {
  Standard: {
    capacity: 2,
    maxOccupancy: 3,
    extraMattressAllowed: true,
    extraMattressPrice: 300,
    amenities: ['AC', 'WiFi', 'TV'],
  },
  Deluxe: {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 350,
    amenities: ['AC', 'WiFi', 'TV', 'Hot Water'],
  },
  'Super Deluxe': {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 350,
    amenities: ['AC', 'WiFi', 'TV', 'Hot Water', 'Sea View'],
  },
  Suite: {
    capacity: 2,
    maxOccupancy: 4,
    extraMattressAllowed: true,
    extraMattressPrice: 500,
    amenities: ['AC', 'WiFi', 'TV', 'Living Area'],
  },
};

const DEFAULT_PRICES = {
  'Standard|AC': 1500,
  'Standard|Non-AC': 1200,
  'Deluxe|AC': 1700,
  'Deluxe|Non-AC': 1400,
  'Super Deluxe|AC': 1900,
  'Super Deluxe|Non-AC': 1600,
  'Suite|AC': 3000,
};

const DEFAULT_POLICIES = {
  checkin: '12:30 PM',
  checkout: '10:00 AM',
  cancellation: 'Please contact the hotel directly for cancellation or modification requests.',
  id: 'Government-approved photo ID is required for all adult guests at check-in.',
  parking: 'Parking is subject to availability at the hotel.',
  wifi: 'Free WiFi is available for hotel guests.',
};

function normalizeRoomType(roomType) {
  if (!roomType || typeof roomType !== 'string') {
    return 'Deluxe'; // Default to Deluxe if missing or invalid
  }

  const lookup = roomType.trim().toLowerCase();
  const normalized = {
    standard: 'Standard',
    deluxe: 'Deluxe',
    'super deluxe': 'Super Deluxe',
    suite: 'Suite',
  }[lookup];

  return normalized || 'Deluxe';
}

function normalizeSubtype(subtype, roomType) {
  if (subtype && typeof subtype === 'string') {
    return subtype.toLowerCase().includes('non') ? 'Non-AC' : 'AC';
  }

  if (roomType === 'Suite') {
    return 'AC';
  }

  return 'AC';
}

function toUtcDate(value, fieldName) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName} date`);
  }

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatIsoDate(value) {
  return value.toISOString().split('T')[0];
}

function formatIndianDate(value) {
  return new Date(value).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function buildBookingId(checkInDate) {
  const datePart = formatIsoDate(checkInDate).replace(/-/g, '');
  const randomPart = Math.floor(100 + Math.random() * 900);
  return `HD${datePart}${randomPart}`;
}

async function getTotalRoomCounts() {
  const records = await prisma.room.findMany();

  if (records.length === 0) {
    return { ...DEFAULT_COUNTS };
  }

  const initialCounts = {
    Standard: 0,
    Deluxe: 0,
    'Super Deluxe': 0,
    Suite: 0,
  };

  return records.reduce((counts, room) => {
    const type = normalizeRoomType(room.roomType || room.type || '');

    if (counts[type] !== undefined) {
      counts[type] += 1;
    }

    return counts;
  }, initialCounts);
}

async function getActiveBookings(checkInDate, checkOutDate) {
  return prisma.booking.findMany({
    where: {
      bookingStatus: { not: 'Cancelled' },
      checkIn: { lt: checkOutDate },
      checkOut: { gt: checkInDate },
    }
  });
}

function countBookings(bookings) {
  const counts = { ...DEFAULT_COUNTS };
  Object.keys(counts).forEach((key) => {
    counts[key] = 0;
  });

  bookings.forEach((booking) => {
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      booking.rooms.forEach((room) => {
        const type = normalizeRoomType(room.roomType || '');
        if (counts[type] !== undefined) {
          counts[type] += Number(room.quantity) || 1;
        }
      });
      return;
    }

    if (booking.roomType) {
      const type = normalizeRoomType(booking.roomType);
      if (counts[type] !== undefined) {
        counts[type] += 1;
      }
    }
  });

  return counts;
}

async function checkAvailability({ roomType, checkIn, checkOut }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const checkInDate = toUtcDate(checkIn, 'checkIn');
  const checkOutDate = toUtcDate(checkOut, 'checkOut');

  if (checkInDate >= checkOutDate) {
    throw new Error('checkOut must be after checkIn');
  }

  const totalCounts = await getTotalRoomCounts();
  const activeBookings = await getActiveBookings(checkInDate, checkOutDate);
  const bookedCounts = countBookings(activeBookings);

  // 1. Fetch blocked dates overlapping with the selected range
  const overlappingBlocks = await prisma.blockedDate.findMany({
    where: {
      startDate: { lt: checkOutDate },
      endDate: { gte: checkInDate }
    }
  });

  const isHotelFullyBlocked = overlappingBlocks.some(block => block.roomType === 'All' || block.roomType === 'all');
  const blockedRoomTypes = new Set(
    overlappingBlocks
      .filter(block => block.roomType !== 'All' && block.roomType !== 'all')
      .map(block => normalizeRoomType(block.roomType))
  );

  let roomsLeft = Math.max(0, (totalCounts[normalizedRoomType] || 0) - (bookedCounts[normalizedRoomType] || 0));

  if (isHotelFullyBlocked || blockedRoomTypes.has(normalizedRoomType)) {
    roomsLeft = 0;
  }

  return {
    available: roomsLeft > 0,
    roomsLeft,
    roomType: normalizedRoomType,
    checkIn: formatIsoDate(checkInDate),
    checkOut: formatIsoDate(checkOutDate),
  };
}

async function getRoomPrice({ roomType, date, subtype }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const targetDate = date ? toUtcDate(date, 'date') : new Date();
  const normalizedSubtype = normalizeSubtype(subtype, normalizedRoomType);

  const seasonalOverride = await prisma.seasonalPrice.findFirst({
    where: {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
      startDate: { lte: targetDate },
      endDate: { gte: targetDate },
    }
  });

  if (seasonalOverride) {
    return {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
      date: formatIsoDate(targetDate),
      price: seasonalOverride.price,
      source: 'seasonal',
    };
  }

  const dbPrice = await prisma.roomPrice.findFirst({
    where: {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
    }
  });

  if (dbPrice) {
    return {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
      date: formatIsoDate(targetDate),
      price: dbPrice.price,
      source: 'database',
    };
  }

  const fallbackPrice = DEFAULT_PRICES[`${normalizedRoomType}|${normalizedSubtype}`] || DEFAULT_PRICES[`${normalizedRoomType}|AC`] || 1500;

  return {
    roomType: normalizedRoomType,
    subtype: normalizedSubtype,
    date: formatIsoDate(targetDate),
    price: fallbackPrice,
    source: 'default',
  };
}

async function getRoomDetails({ roomType }) {
  const normalizedRoomType = normalizeRoomType(roomType);
  const record = await prisma.roomInformation.findUnique({
    where: { roomType: normalizedRoomType }
  });

  if (record) {
    return {
      roomType: normalizedRoomType,
      capacity: record.capacity ?? DEFAULT_DETAILS[normalizedRoomType].capacity,
      maxOccupancy: record.maxOccupancy ?? DEFAULT_DETAILS[normalizedRoomType].maxOccupancy,
      extraMattressAllowed: record.extraMattressAllowed ?? DEFAULT_DETAILS[normalizedRoomType].extraMattressAllowed,
      extraMattressPrice: record.extraMattressPrice ?? DEFAULT_DETAILS[normalizedRoomType].extraMattressPrice,
      amenities: Array.isArray(record.amenities) && record.amenities.length > 0 ? record.amenities : DEFAULT_DETAILS[normalizedRoomType].amenities,
      description: record.description || '',
    };
  }

  return {
    roomType: normalizedRoomType,
    ...DEFAULT_DETAILS[normalizedRoomType],
    description: '',
  };
}

async function getPolicy({ policy }) {
  if (!policy || typeof policy !== 'string') {
    throw new Error('policy is required');
  }

  const normalizedPolicy = policy.trim().toLowerCase().replace(/[^a-z]/g, '');
  const records = await prisma.hotelPolicy.findMany();

  const match = records.find((record) => {
    const title = String(record.title || record.policy || record.key || '').toLowerCase().replace(/[^a-z]/g, '');
    return title.includes(normalizedPolicy) || normalizedPolicy.includes(title);
  });

  if (match) {
    return {
      policy: match.title || policy,
      value: match.content || match.value || '',
    };
  }

  const fallbackValue = {
    checkin: DEFAULT_POLICIES.checkin,
    checkout: DEFAULT_POLICIES.checkout,
    cancellation: DEFAULT_POLICIES.cancellation,
    id: DEFAULT_POLICIES.id,
    identification: DEFAULT_POLICIES.id,
    parking: DEFAULT_POLICIES.parking,
    wifi: DEFAULT_POLICIES.wifi,
  }[normalizedPolicy] || '';

  return {
    policy,
    value: fallbackValue,
  };
}

async function searchFaq({ query }) {
  if (!query || typeof query !== 'string') {
    throw new Error('query is required');
  }

  const normalizedQuery = query.trim().toLowerCase();
  const records = await prisma.faq.findMany();

  const bestMatch = records.find((record) => {
    const question = String(record.question || '').toLowerCase();
    return question.includes(normalizedQuery) || normalizedQuery.includes(question);
  });

  if (bestMatch) {
    return {
      question: bestMatch.question || '',
      answer: bestMatch.answer || '',
    };
  }

  return {
    question: query,
    answer: 'No matching FAQ was found in the hotel database.',
  };
}

async function allocateRoomNumber(roomType, checkInDate, checkOutDate) {
  const roomsOfType = await prisma.room.findMany({
    where: { roomType }
  });
  const overlappingBookings = await prisma.booking.findMany({
    where: {
      roomType,
      bookingStatus: { not: 'Cancelled' },
      checkIn: { lt: checkOutDate },
      checkOut: { gt: checkInDate },
    }
  });

  const occupiedRooms = overlappingBookings.map((booking) => booking.assignedRoom).filter(Boolean);
  const availableRooms = roomsOfType.filter((room) => !occupiedRooms.includes(room.roomNumber));

  if (availableRooms.length > 0) {
    return availableRooms[0].roomNumber;
  }

  if (roomsOfType.length === 0) {
    return 'TBD';
  }

  const typePrefixes = {
    Standard: '10',
    Deluxe: '20',
    'Super Deluxe': '30',
    Suite: '40',
  };

  const prefix = typePrefixes[roomType] || '20';
  let roomNumber = prefix + Math.floor(1 + Math.random() * 9);

  while (occupiedRooms.includes(roomNumber)) {
    roomNumber = prefix + Math.floor(1 + Math.random() * 9);
  }

  return roomNumber;
}

async function createBooking({ guestName, mobile, roomType, checkIn, checkOut, selectedSubtype, specialRequests = '' }) {
  if (!guestName || !mobile || !roomType || !checkIn || !checkOut) {
    throw new Error('guestName, mobile, roomType, checkIn and checkOut are required');
  }

  const normalizedRoomType = normalizeRoomType(roomType);
  const checkInDate = toUtcDate(checkIn, 'checkIn');
  const checkOutDate = toUtcDate(checkOut, 'checkOut');

  const availability = await checkAvailability({
    roomType: normalizedRoomType,
    checkIn: checkInDate,
    checkOut: checkOutDate,
  });

  if (!availability.available) {
    throw new Error(`Only ${availability.roomsLeft} ${normalizedRoomType} room(s) are available on these dates.`);
  }

  const nightlyPrice = await getRoomPrice({
    roomType: normalizedRoomType,
    date: checkInDate,
    subtype: selectedSubtype,
  });

  const roomDetails = await getRoomDetails({ roomType: normalizedRoomType });
  const assignedRoom = await allocateRoomNumber(normalizedRoomType, checkInDate, checkOutDate);
  const nights = Math.max(1, Math.round((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)));
  const totalAmount = nightlyPrice.price * nights;
  const bookingId = buildBookingId(checkInDate);
  const booking = {
    bookingId,
    guestName,
    phone: mobile,
    roomType: normalizedRoomType,
    selectedSubtype: nightlyPrice.subtype,
    assignedRoom,
    checkIn: checkInDate,
    checkOut: checkOutDate,
    totalAmount,
    paidAmount: 0,
    dueAmount: totalAmount,
    paymentStatus: 'Unpaid',
    bookingStatus: 'Confirmed',
    specialRequests,
    rooms: [
      {
        roomType: normalizedRoomType,
        selectedSubtype: nightlyPrice.subtype,
        quantity: 1,
        guests: roomDetails.capacity,
        extraMattress: false,
        pricePerNight: nightlyPrice.price,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await prisma.booking.create({
    data: booking
  });

  return {
    bookingId,
    booking,
  };
}

async function getBookingStatus({ bookingId }) {
  if (!bookingId || typeof bookingId !== 'string') {
    throw new Error('bookingId is required');
  }

  const booking = await prisma.booking.findUnique({
    where: { bookingId }
  });

  if (!booking) {
    throw new Error('Booking not found');
  }

  return {
    bookingId,
    status: booking.bookingStatus || 'Confirmed',
    paymentStatus: booking.paymentStatus || 'Unpaid',
  };
}

async function getRoomRestrictions({ roomType, startDate, endDate } = {}) {
  const where = {};
  if (roomType) {
    where.roomType = normalizeRoomType(roomType);
  }
  if (startDate || endDate) {
    where.endDate = { gte: startDate ? toUtcDate(startDate, 'startDate') : new Date() };
    if (endDate) {
      where.startDate = { lte: toUtcDate(endDate, 'endDate') };
    }
  }
  const restrictions = await prisma.roomRestriction.findMany({
    where,
    orderBy: { startDate: 'asc' }
  });
  return restrictions.map(r => ({
    id: r.id,
    roomType: r.roomType,
    startDate: formatIsoDate(r.startDate),
    endDate: formatIsoDate(r.endDate),
    totalRooms: r.totalRooms,
    blockedCount: r.blockedCount,
    reason: r.reason || 'No reason specified',
    createdAt: r.createdAt
  }));
}

const INDIAN_HOLIDAYS = {
  0: [ // January
    { date: 14, name: "Makar Sankranti / Pongal" },
    { date: 26, name: "Republic Day" }
  ],
  1: [ // February
    { date: 15, name: "Maha Shivratri" },
    { date: 21, name: "Vasant Panchami" }
  ],
  2: [ // March
    { date: 3, name: "Holi (Dhulandi)" },
    { date: 19, name: "Chaitra Navratri Starts" },
    { date: 27, name: "Rama Navami" },
    { date: 30, name: "Mahavir Jayanti" }
  ],
  3: [ // April
    { date: 3, name: "Good Friday" },
    { date: 14, name: "Dr. B.R. Ambedkar Jayanti" },
    { date: 18, name: "Parashurama Jayanti / Akshaya Tritiya" }
  ],
  4: [ // May
    { date: 1, name: "Buddha Purnima" }
  ],
  5: [ // June
    { date: 16, name: "Kabir Jayanti" }
  ],
  6: [ // July
    { date: 15, name: "Muharram" },
    { date: 26, name: "Ashadhi Ekadashi" }
  ],
  7: [ // August
    { date: 15, name: "Independence Day" },
    { date: 27, name: "Raksha Bandhan" },
    { date: 31, name: "Sri Krishna Janmashtami" }
  ],
  8: [ // September
    { date: 4, name: "Ganesh Chaturthi" },
    { date: 5, name: "Teachers' Day" },
    { date: 15, name: "Milad un-Nabi" }
  ],
  9: [ // October
    { date: 2, name: "Mahatma Gandhi Jayanti" },
    { date: 19, name: "Durga Ashtami" },
    { date: 20, name: "Maha Navami / Dussehra" }
  ],
  10: [ // November
    { date: 8, name: "Diwali / Deepavali" },
    { date: 9, name: "Govardhan Puja" },
    { date: 10, name: "Bhai Dooj" },
    { date: 24, name: "Guru Nanak Jayanti" }
  ],
  11: [ // December
    { date: 25, name: "Christmas Day" }
  ]
};

function normalizeDbDate(d) {
  const date = new Date(d);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function createRoomRestriction({ roomType, startDate, endDate, blockedCount, reason }) {
  if (!roomType || !startDate || !endDate || blockedCount === undefined) {
    throw new Error('roomType, startDate, endDate and blockedCount are required');
  }

  const normalizedRoomType = normalizeRoomType(roomType);
  const start = toUtcDate(startDate, 'startDate');
  const end = toUtcDate(endDate, 'endDate');

  if (start > end) {
    throw new Error('startDate must be before or equal to endDate');
  }

  const count = parseInt(blockedCount, 10);
  if (isNaN(count) || count < 1) {
    throw new Error('blockedCount must be a valid positive integer');
  }

  const totalCounts = await getTotalRoomCounts();
  const maxRooms = totalCounts[normalizedRoomType] || 0;

  if (count > maxRooms) {
    throw new Error(`Cannot block ${count} rooms. Only ${maxRooms} physical ${normalizedRoomType} room(s) exist.`);
  }

  const newRestriction = await prisma.roomRestriction.create({
    data: {
      startDate: start,
      endDate: end,
      roomType: normalizedRoomType,
      totalRooms: maxRooms,
      blockedCount: count,
      reason: reason || "",
    }
  });

  return {
    success: true,
    message: `Successfully created restriction: blocked ${count} of ${maxRooms} ${normalizedRoomType} rooms from ${formatIsoDate(start)} to ${formatIsoDate(end)}.`,
    restriction: newRestriction
  };
}

async function createDateBlock({ roomType, startDate, endDate, reason }) {
  if (!startDate || !endDate) {
    throw new Error('startDate and endDate are required');
  }

  const normalizedRoomType = roomType ? (roomType.trim().toLowerCase() === "all" ? "All" : normalizeRoomType(roomType)) : "All";
  const start = new Date(startDate.split("T")[0] + "T00:00:00.000Z");
  const end = new Date(endDate.split("T")[0] + "T23:59:59.999Z");

  if (start > end) {
    throw new Error('startDate must be before or equal to endDate');
  }

  const newBlock = await prisma.blockedDate.create({
    data: {
      startDate: start,
      endDate: end,
      roomType: normalizedRoomType,
      reason: reason || "",
    }
  });

  return {
    success: true,
    message: `Successfully created block: blocked ${normalizedRoomType === "All" ? "entire hotel" : normalizedRoomType + " rooms"} from ${formatIsoDate(start)} to ${formatIsoDate(end)}.`,
    block: newBlock
  };
}

async function updateRoomPrice({ roomType, subtype, price }) {
  if (!roomType || !price) {
    throw new Error('roomType and price are required');
  }

  const normalizedRoomType = normalizeRoomType(roomType);
  const normalizedSubtype = normalizeSubtype(subtype, normalizedRoomType);
  const priceVal = parseFloat(price);

  if (isNaN(priceVal) || priceVal < 0) {
    throw new Error('price must be a valid positive number');
  }

  // Find if exists
  const existing = await prisma.roomPrice.findFirst({
    where: {
      roomType: normalizedRoomType,
      subtype: normalizedSubtype,
    }
  });

  let updatedPrice;
  if (existing) {
    updatedPrice = await prisma.roomPrice.update({
      where: { id: existing.id },
      data: { price: priceVal }
    });
  } else {
    updatedPrice = await prisma.roomPrice.create({
      data: {
        roomType: normalizedRoomType,
        subtype: normalizedSubtype,
        price: priceVal
      }
    });
  }

  return {
    success: true,
    message: `Successfully updated ${normalizedRoomType} ${normalizedSubtype} room price to ₹${priceVal}.`,
    price: updatedPrice
  };
}

async function getOccupancyInsights({ startDate, endDate } = {}) {
  const start = startDate ? toUtcDate(startDate, 'startDate') : new Date();
  const end = endDate ? toUtcDate(endDate, 'endDate') : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  if (start > end) {
    throw new Error('startDate must be before or equal to endDate');
  }

  // Fetch active bookings and blocked dates in this range
  const totalCounts = await getTotalRoomCounts();
  const totalRooms = Object.values(totalCounts).reduce((a, b) => a + b, 0);

  const bookings = await getActiveBookings(start, end);
  const blocks = await prisma.blockedDate.findMany({
    where: {
      startDate: { lt: end },
      endDate: { gte: start }
    }
  });

  // Calculate day-by-day occupancy stats
  const dailyStats = [];
  const curr = new Date(start);
  while (curr <= end) {
    const targetDateStr = formatIsoDate(curr);
    const targetTime = Date.UTC(curr.getUTCFullYear(), curr.getUTCMonth(), curr.getUTCDate());

    // Booked count for this day
    let bookedToday = 0;
    const dailyBookings = bookings.filter(b => {
      const checkInTime = normalizeDbDate(b.checkIn);
      const checkOutTime = normalizeDbDate(b.checkOut);
      return targetTime >= checkInTime && targetTime < checkOutTime;
    });

    dailyBookings.forEach(b => {
      if (Array.isArray(b.rooms) && b.rooms.length > 0) {
        b.rooms.forEach(r => {
          bookedToday += Number(r.quantity) || 1;
        });
      } else {
        bookedToday += 1;
      }
    });

    // Check if fully blocked
    const dayBlocks = blocks.filter(b => {
      const startTime = normalizeDbDate(b.startDate);
      const endTime = normalizeDbDate(b.endDate);
      return targetTime >= startTime && targetTime <= endTime;
    });

    const isFullyBlocked = dayBlocks.some(b => b.roomType === 'All' || b.roomType === 'all');
    
    // Find holiday
    const m = curr.getUTCMonth();
    const d = curr.getUTCDate();
    const holidays = INDIAN_HOLIDAYS[m] || [];
    const holiday = holidays.find(h => h.date === d);

    dailyStats.push({
      date: targetDateStr,
      weekday: curr.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
      occupancyCount: isFullyBlocked ? totalRooms : bookedToday,
      totalCapacity: totalRooms,
      occupancyRate: Math.round(((isFullyBlocked ? totalRooms : bookedToday) / totalRooms) * 100),
      isFullyBlocked,
      holidayName: holiday ? holiday.name : null,
      demandLevel: (isFullyBlocked || (bookedToday / totalRooms) >= 0.75) ? 'High' : (bookedToday / totalRooms) >= 0.4 ? 'Medium' : 'Low'
    });

    curr.setUTCDate(curr.getUTCDate() + 1);
  }

  return {
    startDate: formatIsoDate(start),
    endDate: formatIsoDate(end),
    dailyStats
  };
}

function buildSystemPrompt() {
  return [
    'You are FRIDAY, the official AI assistant for the owner/administrator of Hotel Devang Dwarka.',
    'You are talking directly to the hotel owner/manager/admin, NOT to a guest. Always address them respectfully as the Owner/Admin or Sir/Madam.',
    'Be polite, concise, professional, and operational.',
    'Never guess room availability, prices, or room restrictions.',
    'Always use tools to fetch live database information before answering, including room availability, prices, room details, policies, bookings, booking status, and FAQs.',
    'You have access to admin-only write tools: "create_room_restriction", "create_date_block", and "update_room_price". Always execute these immediately when the owner explicitly commands you to do so.',
    'You also have access to "get_room_restrictions" and "get_occupancy_insights". Use "get_occupancy_insights" to check daily occupancy rates and holidays. If you see high demand (e.g. occupancy >= 75% or holidays), proactively suggest price optimizations (increases).',
    'CRITICAL RULE FOR PRICE SUGGESTIONS: If you proactively suggest a price change based on occupancy/holidays, you MUST ask the owner for permission first (e.g. "Would you like me to update this price?"). You must NEVER call the "update_room_price" tool for a suggestion until the owner replies with explicit approval (e.g. "yes", "do it", "go ahead", "apply suggestion").',
    'Do NOT talk about making a booking for a guest unless the owner explicitly asks you to create a booking.',
    'When the owner asks about dates, convert them to ISO dates before calling tools.',
    'If the question is not related to hotel operations, respond briefly and redirect to hotel services or inventory management.',
  ].join(' ');
}

function getFallbackAssistantReply() {
  return [
    'Sorry, Owner — FRIDAY is temporarily offline for maintenance.',
    'I can still assist you with local lookups for room availability, prices, policies, or FAQs. Please try again in a few minutes.',
  ].join(' ');
}

function getToolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'check_availability',
        description: 'Check live room availability for a room type and date range.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
            checkIn: { type: 'string', description: 'ISO date, for example 2026-06-15' },
            checkOut: { type: 'string', description: 'ISO date, for example 2026-06-16' },
          },
          required: ['roomType', 'checkIn', 'checkOut'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_room_price',
        description: 'Get the room price for a room type on a given date.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
            date: { type: 'string', description: 'ISO date, for example 2026-06-15' },
            subtype: { type: 'string', description: 'Optional AC or Non-AC subtype' },
          },
          required: ['roomType', 'date'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_room_details',
        description: 'Get room capacity, mattress policy, and amenities for a room type.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string' },
          },
          required: ['roomType'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_policy',
        description: 'Fetch a hotel policy from the database.',
        parameters: {
          type: 'object',
          properties: {
            policy: { type: 'string', description: 'Examples: checkin, checkout, cancellation, id, parking, wifi' },
          },
          required: ['policy'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_faq',
        description: 'Look up a common hotel question in the FAQ collection.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_booking',
        description: 'Create a hotel booking after confirming availability.',
        parameters: {
          type: 'object',
          properties: {
            guestName: { type: 'string' },
            mobile: { type: 'string' },
            roomType: { type: 'string' },
            checkIn: { type: 'string' },
            checkOut: { type: 'string' },
            selectedSubtype: { type: 'string' },
            specialRequests: { type: 'string' },
          },
          required: ['guestName', 'mobile', 'roomType', 'checkIn', 'checkOut'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_booking_status',
        description: 'Get the status of an existing booking using the booking ID.',
        parameters: {
          type: 'object',
          properties: {
            bookingId: { type: 'string' },
          },
          required: ['bookingId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_room_restrictions',
        description: 'Fetch active, scheduled, or existing partial room restrictions/blocks set by the owner.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string', description: 'Optional room type (Standard, Deluxe, Super Deluxe, Suite)' },
            startDate: { type: 'string', description: 'Optional ISO start date, e.g. 2026-06-15' },
            endDate: { type: 'string', description: 'Optional ISO end date, e.g. 2026-06-16' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_room_restriction',
        description: 'Create a room restriction to block a specific number of rooms for a room type over a date range. Admin use only.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string', description: 'Room type: Standard, Deluxe, Super Deluxe, Suite' },
            startDate: { type: 'string', description: 'ISO start date, e.g. 2026-06-15' },
            endDate: { type: 'string', description: 'ISO end date, e.g. 2026-06-16' },
            blockedCount: { type: 'number', description: 'Number of rooms of this type to block' },
            reason: { type: 'string', description: 'Reason for blocking' },
          },
          required: ['roomType', 'startDate', 'endDate', 'blockedCount'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_date_block',
        description: 'Fully block a room type or the entire hotel for public booking over a date range. Admin use only.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string', description: 'Room type to block (Standard, Deluxe, Super Deluxe, Suite) or All for entire hotel' },
            startDate: { type: 'string', description: 'ISO start date, e.g. 2026-06-15' },
            endDate: { type: 'string', description: 'ISO end date, e.g. 2026-06-16' },
            reason: { type: 'string', description: 'Reason for block' },
          },
          required: ['startDate', 'endDate'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_room_price',
        description: 'Update the base price for a room type and AC/Non-AC subtype. Admin use only. If proactively suggesting this, always seek owner approval before running.',
        parameters: {
          type: 'object',
          properties: {
            roomType: { type: 'string', description: 'Room type: Standard, Deluxe, Super Deluxe, Suite' },
            subtype: { type: 'string', description: 'Subtype: AC or Non-AC' },
            price: { type: 'number', description: 'New nightly price' },
          },
          required: ['roomType', 'subtype', 'price'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_occupancy_insights',
        description: 'Fetch day-by-day occupancy rates, holiday indicators, and demand projections to suggest price optimizations. Admin use only.',
        parameters: {
          type: 'object',
          properties: {
            startDate: { type: 'string', description: 'ISO start date, e.g. 2026-06-15' },
            endDate: { type: 'string', description: 'ISO end date, e.g. 2026-06-22' },
          },
          required: ['startDate', 'endDate'],
        },
      },
    },
  ];
}

async function runTool(toolName, args) {
  // Normalize arguments (snake_case to camelCase)
  const normalizedArgs = {};
  Object.keys(args || {}).forEach(key => {
    const normalizedKey = key.replace(/_([a-z])/g, (g) => g[1].toUpperCase());
    normalizedArgs[normalizedKey] = args[key];
  });

  // Ensure tool consistency (fallback to camelCase version if snake_case exists in definition)
  switch (toolName) {
    case 'check_availability':
      return checkAvailability(normalizedArgs);
    case 'get_room_price':
      return getRoomPrice(normalizedArgs);
    case 'get_room_details':
      return getRoomDetails(normalizedArgs);
    case 'get_policy':
      return getPolicy(normalizedArgs);
    case 'search_faq':
      return searchFaq(normalizedArgs);
    case 'create_booking':
      return createBooking(normalizedArgs);
    case 'get_booking_status':
      return getBookingStatus(normalizedArgs);
    case 'get_room_restrictions':
      return getRoomRestrictions(normalizedArgs);
    case 'create_room_restriction':
      return createRoomRestriction(normalizedArgs);
    case 'create_date_block':
      return createDateBlock(normalizedArgs);
    case 'update_room_price':
      return updateRoomPrice(normalizedArgs);
    case 'get_occupancy_insights':
      return getOccupancyInsights(normalizedArgs);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

function toGeminiContents(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .flatMap((message) => {
      if (!message) {
        return [];
      }

      if ((message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string') {
        const entry = {
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        };

        if (message.functionCall) {
          entry.parts = [{ functionCall: message.functionCall }];
        }

        return [entry];
      }

      if (message.role === 'tool' && message.name && typeof message.content === 'string') {
        let responsePayload = message.content;
        try {
          responsePayload = JSON.parse(message.content);
        } catch {
          responsePayload = message.content;
        }

        return [{
          role: 'function',
          parts: [{
            functionResponse: {
              name: message.name,
              response: responsePayload,
            },
          }],
        }];
      }

      return [];
    });
}

function getGeminiToolDefinitions() {
  return {
    functionDeclarations: getToolDefinitions().map((tool) => tool.function),
  };
}

async function callGemini(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const payload = {
    systemInstruction: {
      parts: [{ text: buildSystemPrompt() }],
    },
    contents: toGeminiContents(messages),
    tools: [getGeminiToolDefinitions()],
    generationConfig: {
      temperature: 0.2,
    },
  };
  const modelCandidates = [
    process.env.GEMINI_MODEL,
    'gemini-2.0-flash',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-002',
  ].filter(Boolean);

  let lastError = null;

  for (const modelName of [...new Set(modelCandidates)]) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

    try {
      console.log("📤 Sending to Gemini:", JSON.stringify({ modelName, ...payload }, null, 2));
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
      });

      return response.data;
    } catch (error) {
      const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
      lastError = errorDetail;
      const statusCode = error.response?.status;
      
      console.error(`❌ Gemini API Error for model ${modelName}:`, errorDetail);

      // Self-healing: if model is unsupported (404), rate-limited (429), or experiencing a temporary spike (503), continue to other candidates
      const shouldFallback = statusCode === 404 || statusCode === 429 || statusCode === 503;

      if (shouldFallback) {
        console.warn(`🔄 Falling back from model ${modelName} due to status ${statusCode}`);
        continue;
      }

      throw new Error(`Gemini request failed: ${errorDetail}`);
    }
  }

  throw new Error(`Gemini request failed: ${lastError || 'No supported model available'}`);
}

async function persistChatTurn({ sessionId, userMessage, botReply }) {
  await prisma.chatSession.create({
    data: {
      sessionId,
      userMessage,
      botReply,
      timestamp: new Date(),
    }
  });
}

function getLatestUserMessage(messages, fallbackMessage) {
  if (fallbackMessage && typeof fallbackMessage === 'string') {
    return fallbackMessage;
  }

  if (!Array.isArray(messages)) {
    return '';
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }

  return '';
}

function parseDateFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const months = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  const lowered = text.toLowerCase();

  // 1. Matches DD-MM-YYYY or DD/MM/YYYY or DD.MM.YYYY
  // Example: 05-06-2026, 5/6/2026, 5/6
  const mNumeric = lowered.match(/\b(\d{1,2})[-/\.](\d{1,2})(?:[-/\.](\d{2,4}))?\b/);
  if (mNumeric) {
    let day = parseInt(mNumeric[1], 10);
    let month = parseInt(mNumeric[2], 10) - 1; // 0-indexed
    let year = mNumeric[3] ? parseInt(mNumeric[3], 10) : (new Date()).getFullYear();
    if (year < 100) year += 2000; // handle 2-digit years
    
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  // 2. Matches "5th of june", "5 june", "5th june 2026"
  const mDayMonth = lowered.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:of)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/i);
  if (mDayMonth) {
    let day = parseInt(mDayMonth[1], 10);
    const monAbbr = mDayMonth[2].toLowerCase();
    const year = mDayMonth[3] ? parseInt(mDayMonth[3], 10) : (new Date()).getFullYear();
    const fullNames = {
      jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
      jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december'
    };
    const monthName = fullNames[monAbbr];
    if (monthName && months[monthName] !== undefined) {
      const month = months[monthName];
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  // 3. Matches "june 5", "june 5th", "june 5th 2026"
  const mMonthDay = lowered.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i);
  if (mMonthDay) {
    const monAbbr = mMonthDay[1].toLowerCase();
    let day = parseInt(mMonthDay[2], 10);
    const year = mMonthDay[3] ? parseInt(mMonthDay[3], 10) : (new Date()).getFullYear();
    const fullNames = {
      jan: 'january', feb: 'february', mar: 'march', apr: 'april', may: 'may', jun: 'june',
      jul: 'july', aug: 'august', sep: 'september', oct: 'october', nov: 'november', dec: 'december'
    };
    const monthName = fullNames[monAbbr];
    if (monthName && months[monthName] !== undefined) {
      const month = months[monthName];
      try {
        const d = new Date(Date.UTC(year, month, day));
        if (!isNaN(d.getTime())) return d;
      } catch (e) {}
    }
  }

  return null;
}

function isAvailabilityQuestion(text) {
  if (!text || typeof text !== 'string') return false;
  const lowered = text.toLowerCase();
  const hasKeywords = /avail|is there a room|rooms left|rooms free|vacan|any room|rooms for|book|stay|status|stastus|stat/i.test(lowered);
  const hasDatePattern = /\b\d{1,2}\b|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(lowered);
  return hasKeywords && hasDatePattern;
}

async function getLocalCalendarReply(text) {
  const lowered = text.toLowerCase();
  
  // 1. Detect which room type is queried (fallback to Standard)
  let roomType = 'Standard';
  if (lowered.includes('deluxe') && !lowered.includes('super')) roomType = 'Deluxe';
  else if (lowered.includes('super deluxe')) roomType = 'Super Deluxe';
  else if (lowered.includes('suite')) roomType = 'Suite';
  else if (lowered.includes('standard')) roomType = 'Standard';

  // 2. Determine target month and year (default to June 2026 or current month if no match)
  let targetMonth = 5; // June (0-indexed)
  let targetYear = 2026;
  
  const now = new Date();
  if (lowered.includes('june') || lowered.includes('jun')) targetMonth = 5;
  else if (lowered.includes('july') || lowered.includes('jul')) targetMonth = 6;
  else if (lowered.includes('august') || lowered.includes('aug')) targetMonth = 7;
  else if (lowered.includes('september') || lowered.includes('sep')) targetMonth = 8;
  else {
    if (now.getFullYear() > 2026 || (now.getFullYear() === 2026 && now.getMonth() >= 5)) {
      targetMonth = now.getMonth();
      targetYear = now.getFullYear();
    } else {
      targetMonth = 5; // June
      targetYear = 2026;
    }
  }

  // 3. Fetch all blocked dates and active bookings for this month
  const startOfMonth = new Date(Date.UTC(targetYear, targetMonth, 1));
  const endOfMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0, 23, 59, 59, 999));
  
  const blocks = await prisma.blockedDate.findMany({
    where: {
      startDate: { lte: endOfMonth },
      endDate: { gte: startOfMonth }
    }
  });

  const totalDays = endOfMonth.getUTCDate();
  const totalCounts = await getTotalRoomCounts();
  const roomCapacity = totalCounts[normalizeRoomType(roomType)] || 0;

  // Initialize booked count for each day
  const dailyBookedCounts = {};
  for (let d = 1; d <= totalDays; d++) {
    dailyBookedCounts[d] = 0;
  }

  // A. Add administrative block dates
  blocks.forEach(block => {
    const isAllBlock = block.roomType === 'All' || block.roomType === 'all';
    const isMatchingType = normalizeRoomType(block.roomType) === normalizeRoomType(roomType);
    
    if (isAllBlock || isMatchingType) {
      const blockStart = new Date(block.startDate);
      const blockEnd = new Date(block.endDate);
      
      const startDay = blockStart < startOfMonth ? 1 : blockStart.getUTCDate();
      const endDay = blockEnd > endOfMonth ? totalDays : blockEnd.getUTCDate();
      
      for (let d = startDay; d <= endDay; d++) {
        dailyBookedCounts[d] = roomCapacity; // Mark fully blocked
      }
    }
  });

  // B. Add active bookings overlapping with the month
  const activeBookings = await getActiveBookings(startOfMonth, endOfMonth);
  activeBookings.forEach(booking => {
    let quantity = 0;
    if (Array.isArray(booking.rooms) && booking.rooms.length > 0) {
      booking.rooms.forEach(room => {
        if (normalizeRoomType(room.roomType) === normalizeRoomType(roomType)) {
          quantity += Number(room.quantity) || 1;
        }
      });
    } else if (booking.roomType && normalizeRoomType(booking.roomType) === normalizeRoomType(roomType)) {
      quantity += 1;
    }

    if (quantity > 0) {
      const bStart = new Date(booking.checkIn);
      const bEnd = new Date(booking.checkOut);
      
      const startDay = bStart < startOfMonth ? 1 : bStart.getUTCDate();
      const endDay = bEnd > endOfMonth ? totalDays : Math.max(1, bEnd.getUTCDate() - 1);
      
      for (let d = startDay; d <= endDay; d++) {
        if (d >= 1 && d <= totalDays) {
          dailyBookedCounts[d] = (dailyBookedCounts[d] || 0) + quantity;
        }
      }
    }
  });

  // C. Build set of blocked/fully booked days
  const blockedDays = new Set();
  for (let d = 1; d <= totalDays; d++) {
    if (dailyBookedCounts[d] >= roomCapacity) {
      blockedDays.add(d);
    }
  }

  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const monthName = monthNames[targetMonth];

  let reply = `📅 **Live Calendar for ${roomType} Rooms (${monthName} ${targetYear})**:\n\n`;

  if (blockedDays.size === 0) {
    reply += `✨ Great news! All dates in **${monthName}** are currently fully available for **${roomType}** rooms! ✅`;
  } else if (blockedDays.size === totalDays) {
    reply += `⚠️ Note: All dates in **${monthName}** are currently administrative blocked or fully booked for **${roomType}** rooms. ❌`;
  } else {
    // Group available ranges
    const availableRanges = [];
    let rangeStart = null;

    for (let d = 1; d <= totalDays; d++) {
      const isAvailable = !blockedDays.has(d);
      if (isAvailable) {
        if (rangeStart === null) {
          rangeStart = d;
        }
      } else {
        if (rangeStart !== null) {
          availableRanges.push({ start: rangeStart, end: d - 1 });
          rangeStart = null;
        }
      }
    }
    if (rangeStart !== null) {
      availableRanges.push({ start: rangeStart, end: totalDays });
    }

    reply += `✅ **Available Dates**:\n`;
    availableRanges.forEach(r => {
      if (r.start === r.end) {
        reply += `• **${r.start} ${monthName}**\n`;
      } else {
        reply += `• **${r.start} to ${r.end} ${monthName}**\n`;
      }
    });

    reply += `\n❌ **Blocked / Fully Booked Dates**:\n`;
    const blockedRanges = [];
    let bStart = null;
    for (let d = 1; d <= totalDays; d++) {
      const isBlocked = blockedDays.has(d);
      if (isBlocked) {
        if (bStart === null) {
          bStart = d;
        }
      } else {
        if (bStart !== null) {
          blockedRanges.push({ start: bStart, end: d - 1 });
          bStart = null;
        }
      }
    }
    if (bStart !== null) {
      blockedRanges.push({ start: bStart, end: totalDays });
    }
    blockedRanges.forEach(r => {
      if (r.start === r.end) {
        reply += `• ${r.start} ${monthName}\n`;
      } else {
        reply += `• ${r.start} to ${r.end} ${monthName}\n`;
      }
    });
  }

  reply += `\nWould you like me to help you check restrictions or manage occupancy for these dates, Owner?`;
  return reply;
}

async function getLocalPricesReply() {
  return [
    `🙏 Greetings, Owner! Here are the configured standard nightly rates for the hotel:`,
    ``,
    `🛏️ **Standard Room**`,
    `• **AC**: ₹1,400 per night`,
    `• **Non-AC**: ₹1,100 per night`,
    ``,
    `🛏️ **Deluxe Room**`,
    `• **AC**: ₹1,700 per night`,
    `• **Non-AC**: ₹1,400 per night`,
    ``,
    `🛏️ **Super Deluxe Room**`,
    `• **AC**: ₹1,900 per night`,
    `• **Non-AC**: ₹1,600 per night`,
    ``,
    `🛏️ **Suite Room**`,
    `• **AC**: ₹3,000 per night`,
    ``,
    `*Note: Stated prices are standard nightly rates. Would you like me to assist you in reviewing seasonal prices or checking availability?*`
  ].join('\n');
}

async function getLocalPolicyReply(text) {
  const lowered = text.toLowerCase();
  let policyKey = '';
  if (lowered.includes('checkin') || lowered.includes('check-in')) policyKey = 'checkin';
  else if (lowered.includes('checkout') || lowered.includes('check-out')) policyKey = 'checkout';
  else if (lowered.includes('cancel')) policyKey = 'cancellation';
  else if (lowered.includes('parking')) policyKey = 'parking';
  else if (lowered.includes('wifi') || lowered.includes('internet')) policyKey = 'wifi';
  else if (lowered.includes('id ') || lowered.includes('proof') || lowered.includes('card') || lowered.includes('identity')) policyKey = 'id';

  if (policyKey) {
    try {
      const res = await getPolicy({ policy: policyKey });
      if (res && res.value) {
        return `🙏 **Hotel Policies** - *${res.policy}*:\n\n${res.value}\n\nIs there anything else I can help you with, Owner?`;
      }
    } catch (e) {}
  }
  return null;
}

async function getLocalFaqReply(text) {
  try {
    const res = await searchFaq({ query: text });
    if (res && res.answer && res.answer !== 'No matching FAQ was found in the hotel database.') {
      return `🙏 **Hotel FAQ**:\n\n**Q: ${res.question}**\n**A:** ${res.answer}\n\nIs there anything else I can help you with, Owner?`;
    }
  } catch (e) {}
  return null;
}

function getFriendlyFallbackReply() {
  return [
    `🙏 Greetings, Owner/Admin!`,
    ``,
    `I am FRIDAY, your automated management assistant. I am currently performing a brief update, but I can still assist you with:`,
    `✅ **Live room availability and occupancy**`,
    `✅ **Standard room prices and rates**`,
    `✅ **Hotel policies**`,
    ``,
    `For system troubleshooting or backend queries, please contact direct systems support.`
  ].join('\n');
}

async function generateAssistantReply({ sessionId, messages = [], userMessage }) {
  const activeSessionId = sessionId || (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString());
  const conversation = Array.isArray(messages) && messages.length > 0
    ? messages.filter((message) => message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string')
    : userMessage
      ? [{ role: 'user', content: userMessage }]
      : [];

  let iterations = 0;

  // Quick-path: if the user's latest message looks like an availability question, try to answer directly
  const latestUser = getLatestUserMessage(messages, userMessage);
  if (isAvailabilityQuestion(latestUser)) {
    const checkDate = parseDateFromText(latestUser);
    if (!checkDate) {
      // ask for clarification via normal flow
    } else {
      try {
        const types = Object.keys(DEFAULT_COUNTS);
        const checkIn = checkDate;
        const checkOut = new Date(checkIn.getTime() + 24 * 60 * 60 * 1000);
        const results = [];
        for (const t of types) {
          try {
            const avail = await checkAvailability({ roomType: t, checkIn, checkOut });
            results.push({ roomType: t, available: avail.available, roomsLeft: avail.roomsLeft });
          } catch (e) {
            results.push({ roomType: t, error: e.message });
          }
        }

        const dateStr = formatIndianDate(checkIn);
        let reply = `🙏 Greetings, Owner! Here is the live room availability for **${dateStr}**:\n\n`;
        
        let allSoldOut = true;
        results.forEach(r => {
          if (!r.error && r.available) {
            allSoldOut = false;
          }
        });

        if (allSoldOut) {
          reply += `⚠️ Note: All rooms are fully booked or blocked for this date.`;
        } else {
          results.forEach(r => {
            if (r.error) {
              reply += `• **${r.roomType}**: Status unknown (${r.error})\n`;
            } else if (r.available) {
              reply += `✅ **${r.roomType}**: ${r.roomsLeft} room${r.roomsLeft > 1 ? 's' : ''} available\n`;
            } else {
              reply += `❌ **${r.roomType}**: Fully booked / Sold out\n`;
            }
          });
          reply += `\nWould you like me to assist you with managing restrictions or bookings for **${dateStr}**?`;
        }

        try {
          await persistChatTurn({ sessionId: activeSessionId, userMessage: latestUser, botReply: reply });
        } catch (err) {
          console.error('❌ Chat persistence error in availability quick-path:', err.message);
        }

        return { sessionId: activeSessionId, reply, messages: conversation.slice(1) };
      } catch (err) {
        console.error('❌ Availability quick-path error:', err.message);
        // fall through to normal flow
      }
    }
  }

  while (iterations < 5) {
    iterations += 1;
    let completion;

    try {
      completion = await callGemini(conversation);
    } catch (error) {
      console.error('❌ Gemini main assistant call failed:', error.message);
      
      let fallbackReply = '';
      const loweredUser = latestUser.toLowerCase();

      // 1. Check for calendar availability queries
      if (/date|calendar|when|which day|open day/i.test(loweredUser) && /avail|free|vacan|block|open/i.test(loweredUser)) {
        fallbackReply = await getLocalCalendarReply(latestUser);
      }
      // 2. Check for pricing queries
      else if (/price|rate|cost|charge|tariff|rent|amount|proice|pricing|fare/i.test(loweredUser)) {
        fallbackReply = await getLocalPricesReply();
      } 
      // 3. Check for policies queries
      else if (/checkin|check-in|checkout|check-out|timing|time|cancel|policy|parking|wifi|internet|id|proof|card|identity/i.test(loweredUser)) {
        const policyRes = await getLocalPolicyReply(latestUser);
        if (policyRes) fallbackReply = policyRes;
      }

      // 3. Check FAQs if still empty
      if (!fallbackReply) {
        const faqRes = await getLocalFaqReply(latestUser);
        if (faqRes) fallbackReply = faqRes;
      }

      // 4. Fallback to highly helpful customer guide bubble
      if (!fallbackReply) {
        fallbackReply = getFriendlyFallbackReply();
      }

      try {
        await persistChatTurn({
          sessionId: activeSessionId,
          userMessage: latestUser,
          botReply: fallbackReply,
        });
      } catch (persistError) {
        console.error('❌ Chat persistence error during fallback:', persistError.message);
      }

      return {
        sessionId: activeSessionId,
        reply: fallbackReply,
        messages: conversation.slice(1)
      };
    }

    const candidate = completion?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCallPart = parts.find((part) => part.functionCall);

    if (functionCallPart && functionCallPart.functionCall) {
      const { name, args } = functionCallPart.functionCall;
      let toolResult;
      try {
        toolResult = await runTool(name, args || {});
      } catch (err) {
        toolResult = { error: err.message };
      }

      conversation.push({
        role: 'assistant',
        content: '',
        functionCall: functionCallPart.functionCall,
      });
      conversation.push({
        role: 'tool',
        name,
        content: JSON.stringify(toolResult),
      });
      continue;
    }

    const finalReply = parts
      .map((part) => part.text || '')
      .join('')
      .trim() || 'I could not generate a response right now.';
    try {
      await persistChatTurn({
        sessionId: activeSessionId,
        userMessage: getLatestUserMessage(messages, userMessage),
        botReply: finalReply,
      });
    } catch (persistError) {
      console.error('❌ Chat persistence error:', persistError.message);
    }

    return {
      sessionId: activeSessionId,
      reply: finalReply,
      messages: conversation.slice(1),
    };
  }

  throw new Error('Assistant exceeded the tool-calling limit');
}

module.exports = {
  checkAvailability,
  getRoomPrice,
  getRoomDetails,
  getPolicy,
  searchFaq,
  createBooking,
  getBookingStatus,
  generateAssistantReply,
  formatIndianDate,
};