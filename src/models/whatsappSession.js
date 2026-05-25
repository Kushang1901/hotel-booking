const { getCollection } = require('../config/db');

const CLIENT_ID = 'hotel-devang';

/**
 * Gets the current WhatsApp session metadata.
 * If none exists, returns null.
 */
async function getSession() {
    try {
        const collection = getCollection('whatsapp_sessions');
        return await collection.findOne({ clientId: CLIENT_ID });
    } catch (error) {
        console.error("❌ Error in getSession:", error);
        return null;
    }
}

/**
 * Updates or creates the WhatsApp session metadata.
 * @param {object} updateData 
 */
async function updateSession(updateData) {
    try {
        const collection = getCollection('whatsapp_sessions');
        const now = new Date();
        
        const result = await collection.findOneAndUpdate(
            { clientId: CLIENT_ID },
            { 
                $set: { 
                    ...updateData, 
                    updatedAt: now 
                },
                $setOnInsert: {
                    createdAt: now
                }
            },
            { 
                upsert: true,
                returnDocument: 'after'
            }
        );
        return result;
    } catch (error) {
        console.error("❌ Error in updateSession:", error);
        throw error;
    }
}

/**
 * Sets the WhatsApp status to CONNECTED and resets the QR code.
 * @param {string} ownerNumber 
 */
async function setConnected(ownerNumber) {
    return await updateSession({
        status: 'CONNECTED',
        qrCode: null,
        ownerNumber: ownerNumber || null,
        lastConnectedAt: new Date(),
        error: null
    });
}

/**
 * Saves a new QR code and sets status to QR_READY.
 * @param {string} qrText 
 */
async function saveQrCode(qrText) {
    return await updateSession({
        status: 'QR_READY',
        qrCode: qrText,
        error: null
    });
}

/**
 * Sets status to DISCONNECTED or custom error state.
 * @param {string} errorMsg 
 */
async function setDisconnected(errorMsg = null) {
    return await updateSession({
        status: 'DISCONNECTED',
        qrCode: null,
        error: errorMsg
    });
}

module.exports = {
    getSession,
    updateSession,
    setConnected,
    saveQrCode,
    setDisconnected,
    CLIENT_ID
};
