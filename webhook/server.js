const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const CALENDAR_ID     = process.env.GOOGLE_CALENDAR_ID || 'primary';
const TIMEZONE        = process.env.TIMEZONE || 'Europe/Paris';
const CALENDAR_COLORS = { URGENT: '11', MOYEN: '5', FAIBLE: '2' };
const AFTERNOON_SLOTS = new Set(['après-midi', 'apres-midi', 'pm']);

if (!process.env.ELEVENLABS_WEBHOOK_SECRET) {
  console.warn('⚠️  ELEVENLABS_WEBHOOK_SECRET non défini — vérification signature désactivée');
}

// ─────────────────────────────────────────────
// Calendar client singleton
// ─────────────────────────────────────────────
function createCalendarClient() {
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
const calendar = createCalendarClient();

// ─────────────────────────────────────────────
// Vérification signature ElevenLabs (sécurité)
// ─────────────────────────────────────────────
function verifyElevenLabsSignature(req) {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (!secret) return true;

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
  const params = body.parameters || body;
  return {
    clientName:    params.client_name    || params.clientName    || 'Client inconnu',
    clientPhone:   params.client_phone   || params.clientPhone   || '',
    clientAddress: params.client_address || params.clientAddress || '',
    serviceType:   params.service_type   || params.serviceType   || 'Intervention',
    dateStr:       params.date           || '',
    timeSlot:      params.time_slot      || params.timeSlot      || 'matin',
    startTime:     params.start_time     || params.startTime     || '',
    urgency:       params.urgency        || 'FAIBLE',
    notes:         params.notes          || '',
  };
}

// ─────────────────────────────────────────────
// Calcule start/end datetime selon créneau
// ─────────────────────────────────────────────
function buildDateTimes(dateStr, timeSlot, startTime) {
  let date = dateStr;
  if (!date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    date = tomorrow.toISOString().split('T')[0];
  }

  let startHour, endHour;

  if (startTime) {
    const base = new Date(`2000-01-01T${startTime}:00`);
    const end  = new Date(base.getTime() + 60 * 60 * 1000);
    const fmt  = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    startHour  = fmt(base);
    endHour    = fmt(end);
  } else if (AFTERNOON_SLOTS.has(timeSlot)) {
    startHour = '13:00';
    endHour   = '14:00';
  } else {
    startHour = '08:00';
    endHour   = '09:00';
  }

  return {
    start: { dateTime: `${date}T${startHour}:00`, timeZone: TIMEZONE },
    end:   { dateTime: `${date}T${endHour}:00`,   timeZone: TIMEZONE },
  };
}

// ─────────────────────────────────────────────
// Couleur selon urgence
// ─────────────────────────────────────────────
function getColorId(urgency) {
  return CALENDAR_COLORS[urgency?.toUpperCase()] || CALENDAR_COLORS.FAIBLE;
}

// ─────────────────────────────────────────────
// Route principale : créer un RDV
// ─────────────────────────────────────────────
app.post('/webhook/create-event', async (req, res) => {
  console.log('📞 Webhook reçu:', JSON.stringify(req.body, null, 2));

  if (!verifyElevenLabsSignature(req)) {
    console.warn('⚠️  Signature invalide');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = parseAppointmentData(req.body);
    const { start, end } = buildDateTimes(data.dateStr, data.timeSlot, data.startTime);

    const description = [
      `👤 Client : ${data.clientName}`,
      `📞 Téléphone : ${data.clientPhone}`,
      data.clientAddress ? `📍 Adresse : ${data.clientAddress}` : '',
      `🔧 Prestation : ${data.serviceType}`,
      `⚠️  Urgence : ${data.urgency}`,
      data.notes ? `📝 Notes : ${data.notes}` : '',
      ``,
      `─── Créé automatiquement par AssistantPro ───`,
      `📅 Appel reçu le : ${new Date().toLocaleString('fr-FR', { timeZone: TIMEZONE })}`,
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
          { method: 'email',  minutes: 1440 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    console.log('✅ Événement créé:', response.data.htmlLink);

    return res.status(200).json({
      success: true,
      event_id:   response.data.id,
      event_link: response.data.htmlLink,
      message: `RDV confirmé pour ${data.clientName} le ${start.dateTime.replace('T', ' à ').slice(0, 19)}`,
    });

  } catch (err) {
    console.error('❌ Erreur création événement:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Route : lister les RDV du jour (optionnel)
// ─────────────────────────────────────────────
app.get('/webhook/today-events', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      fields: 'items(id,summary,start,end,location)',
    });

    const events = (response.data.items || []).map(e => ({
      id:       e.id,
      title:    e.summary,
      start:    e.start?.dateTime || e.start?.date,
      end:      e.end?.dateTime   || e.end?.date,
      location: e.location,
    }));

    return res.json({ success: true, events });
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
