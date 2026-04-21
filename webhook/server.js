const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
// Auth Google Calendar via Service Account
// ─────────────────────────────────────────────
function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      type: 'service_account',
      project_id: process.env.GOOGLE_PROJECT_ID,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
      private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      client_id: process.env.GOOGLE_CLIENT_ID,
    },
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ─────────────────────────────────────────────
// Vérification signature ElevenLabs (sécurité)
// ─────────────────────────────────────────────
function verifyElevenLabsSignature(req) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true; // désactivé si pas de secret configuré

  const signature = req.headers['elevenlabs-signature'];
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(JSON.stringify(req.body));
  const expected = 'sha256=' + hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─────────────────────────────────────────────
// Parser les données reçues depuis l'agent
// ─────────────────────────────────────────────
function parseAppointmentData(body) {
  // ElevenLabs envoie les paramètres de l'outil dans body.parameters
  const params = body.parameters || body;

  return {
    clientName:   params.client_name   || params.clientName   || 'Client inconnu',
    clientPhone:  params.client_phone  || params.clientPhone  || '',
    clientAddress:params.client_address|| params.clientAddress|| '',
    serviceType:  params.service_type  || params.serviceType  || 'Intervention',
    dateStr:      params.date          || '',          // ex: "2026-04-20"
    timeSlot:     params.time_slot     || params.timeSlot || 'matin', // "matin" | "après-midi"
    startTime:    params.start_time    || params.startTime || '',    // ex: "09:00"
    urgency:      params.urgency       || 'FAIBLE',
    notes:        params.notes         || '',
  };
}

// ─────────────────────────────────────────────
// Calcule start/end datetime selon créneau
// ─────────────────────────────────────────────
function buildDateTimes(dateStr, timeSlot, startTime) {
  // Si date non fournie → prend demain
  let date = dateStr;
  if (!date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    date = tomorrow.toISOString().split('T')[0];
  }

  let startHour, endHour;

  if (startTime) {
    const [h, m] = startTime.split(':').map(Number);
    startHour = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
    endHour   = `${String(h + 1).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  } else if (timeSlot === 'après-midi' || timeSlot === 'apres-midi' || timeSlot === 'pm') {
    startHour = '13:00';
    endHour   = '14:00';
  } else {
    // matin par défaut
    startHour = '08:00';
    endHour   = '09:00';
  }

  const timeZone = process.env.TIMEZONE || 'Europe/Paris';

  return {
    start: { dateTime: `${date}T${startHour}:00`, timeZone },
    end:   { dateTime: `${date}T${endHour}:00`,   timeZone },
  };
}

// ─────────────────────────────────────────────
// Couleur selon urgence
// ─────────────────────────────────────────────
function getColorId(urgency) {
  switch (urgency?.toUpperCase()) {
    case 'URGENT': return '11'; // rouge tomate
    case 'MOYEN':  return '5';  // jaune banane
    default:       return '2';  // vert sauge (FAIBLE)
  }
}

// ─────────────────────────────────────────────
// Route principale : créer un RDV
// ─────────────────────────────────────────────
app.post('/webhook/create-event', async (req, res) => {
  console.log('📞 Webhook reçu:', JSON.stringify(req.body, null, 2));

  // Vérification sécurité
  if (!verifyElevenLabsSignature(req)) {
    console.warn('⚠️  Signature invalide');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = parseAppointmentData(req.body);
    const { start, end } = buildDateTimes(data.dateStr, data.timeSlot, data.startTime);

    // Construction de la description riche
    const description = [
      `👤 Client : ${data.clientName}`,
      `📞 Téléphone : ${data.clientPhone}`,
      data.clientAddress ? `📍 Adresse : ${data.clientAddress}` : '',
      `🔧 Prestation : ${data.serviceType}`,
      `⚠️  Urgence : ${data.urgency}`,
      data.notes ? `📝 Notes : ${data.notes}` : '',
      ``,
      `─── Créé automatiquement par AssistantPro ───`,
      `📅 Appel reçu le : ${new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`,
    ].filter(Boolean).join('\n');

    const event = {
      summary: `RDV ${data.clientName} — ${data.serviceType}`,
      description,
      location: data.clientAddress,
      start,
      end,
      colorId: getColorId(data.urgency),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup',  minutes: 60 },
          { method: 'email',  minutes: 1440 }, // veille
        ],
      },
    };

    const calendar = getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    const response = await calendar.events.insert({
      calendarId,
      resource: event,
    });

    console.log('✅ Événement créé:', response.data.htmlLink);

    // Réponse au format attendu par ElevenLabs
    return res.status(200).json({
      success: true,
      event_id:   response.data.id,
      event_link: response.data.htmlLink,
      message: `RDV confirmé pour ${data.clientName} le ${start.dateTime.replace('T', ' à ').slice(0, 19)}`,
    });

  } catch (err) {
    console.error('❌ Erreur création événement:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ─────────────────────────────────────────────
// Route : lister les RDV du jour (optionnel)
// ─────────────────────────────────────────────
app.get('/webhook/today-events', async (req, res) => {
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59);

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: now.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (response.data.items || []).map(e => ({
      id:      e.id,
      title:   e.summary,
      start:   e.start?.dateTime || e.start?.date,
      end:     e.end?.dateTime   || e.end?.date,
      location:e.location,
    }));

    return res.json({ success: true, count: events.length, events });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Health check
// ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'AssistantPro Webhook', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AssistantPro Webhook démarré sur le port ${PORT}`);
});
