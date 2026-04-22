const express = require('express');
const { google } = require('googleapis');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const CALENDAR_ID    = process.env.GOOGLE_CALENDAR_ID || 'primary';
const SHEET_ID       = process.env.GOOGLE_SHEET_ID || '';
const SHEET_TAB      = process.env.GOOGLE_SHEET_TAB || 'Appels';
const TIMEZONE       = process.env.TIMEZONE || 'Europe/Paris';
const WORK_START     = process.env.WORK_START || '08:00';
const WORK_END       = process.env.WORK_END || '18:00';
const SLOT_MINUTES   = 30;
const BUFFER_MINUTES = 30;
const CALENDAR_COLORS = { URGENT: '11', MOYEN: '5', FAIBLE: '2' };

if (!process.env.ELEVENLABS_WEBHOOK_SECRET) {
  console.warn('⚠️  ELEVENLABS_WEBHOOK_SECRET non défini — vérification signature désactivée');
}
if (!SHEET_ID) {
  console.warn('⚠️  GOOGLE_SHEET_ID non défini — intégration Sheets désactivée');
}

// ─────────────────────────────────────────────
// Auth Google partagée (Calendar + Sheets)
// ─────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: {
    type: 'service_account',
    project_id:   process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key:  process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    client_id:    process.env.GOOGLE_CLIENT_ID,
  },
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
  ],
});

const calendar = google.calendar({ version: 'v3', auth });
const sheets   = google.sheets({ version: 'v4', auth });

// ─────────────────────────────────────────────
// Vérification signature ElevenLabs
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
function parseCallData(body) {
  const p = body.parameters || body;
  return {
    clientName:      p.client_name      || p.clientName      || 'Client inconnu',
    clientPhone:     p.client_phone     || p.clientPhone     || '',
    clientAddress:   p.client_address   || p.clientAddress   || '',
    serviceType:     p.service_type     || p.serviceType     || 'Intervention',
    dateStr:         p.date             || '',
    startTime:       p.start_time       || p.startTime       || '',
    urgency:         p.urgency          || 'FAIBLE',
    notes:           p.notes            || '',
    appointmentMade: p.appointment_made || p.appointmentMade || false,
    eventLink:       p.event_link       || p.eventLink       || '',
  };
}

// ─────────────────────────────────────────────
// Calcule start/end pour un créneau de 30 min
// ─────────────────────────────────────────────
function buildDateTimes(dateStr, startTime) {
  let date = dateStr;
  if (!date) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    date = tomorrow.toISOString().split('T')[0];
  }

  const startHour = startTime
    ? (startTime.includes(':') ? startTime : `${startTime}:00`)
    : WORK_START;

  const base   = new Date(`2000-01-01T${startHour}:00`);
  const endMs  = base.getTime() + SLOT_MINUTES * 60 * 1000;
  const endDate = new Date(endMs);
  const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

  return {
    start: { dateTime: `${date}T${startHour}:00`, timeZone: TIMEZONE },
    end:   { dateTime: `${date}T${fmt(endDate)}:00`, timeZone: TIMEZONE },
  };
}

// ─────────────────────────────────────────────
// Créneaux disponibles (30 min + 30 min buffer)
// ─────────────────────────────────────────────
function findAvailableSlots(events, date) {
  const SLOT_MS   = SLOT_MINUTES   * 60 * 1000;
  const BUFFER_MS = BUFFER_MINUTES * 60 * 1000;

  const dayStart = new Date(`${date}T${WORK_START}:00`);
  const dayEnd   = new Date(`${date}T${WORK_END}:00`);

  const timedEvents = events
    .filter(e => e.start?.dateTime)
    .map(e => ({
      start: new Date(e.start.dateTime),
      end:   new Date(e.end.dateTime),
    }));

  const slots = [];
  let current = new Date(dayStart);

  while (current.getTime() + SLOT_MS <= dayEnd.getTime()) {
    const slotEnd = new Date(current.getTime() + SLOT_MS);

    // A slot conflicts if it doesn't leave 30 min buffer around existing events
    const conflicts = timedEvents.some(e => {
      const beforeOk = slotEnd.getTime() <= e.start.getTime() - BUFFER_MS;
      const afterOk  = current.getTime() >= e.end.getTime() + BUFFER_MS;
      return !(beforeOk || afterOk);
    });

    if (!conflicts) {
      const hh = String(current.getHours()).padStart(2, '0');
      const mm = String(current.getMinutes()).padStart(2, '0');
      slots.push(`${hh}:${mm}`);
    }

    current = new Date(current.getTime() + SLOT_MS);
  }

  return slots;
}

// ─────────────────────────────────────────────
// Couleur selon urgence
// ─────────────────────────────────────────────
function getColorId(urgency) {
  return CALENDAR_COLORS[urgency?.toUpperCase()] || CALENDAR_COLORS.FAIBLE;
}

// ─────────────────────────────────────────────
// Route : créneaux disponibles pour une date
// ─────────────────────────────────────────────
app.get('/webhook/available-slots', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Paramètre date requis au format YYYY-MM-DD' });
  }

  try {
    const response = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      new Date(`${date}T00:00:00`).toISOString(),
      timeMax:      new Date(`${date}T23:59:59`).toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      fields:       'items(start,end)',
    });

    const slots = findAvailableSlots(response.data.items || [], date);

    return res.json({
      success: true,
      date,
      available_slots: slots,
      slot_duration_minutes: SLOT_MINUTES,
      buffer_minutes: BUFFER_MINUTES,
    });
  } catch (err) {
    console.error('❌ Erreur créneaux disponibles:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Route : créer un RDV (30 min) dans Calendar
// ─────────────────────────────────────────────
app.post('/webhook/create-event', async (req, res) => {
  console.log('📞 Webhook create-event reçu:', JSON.stringify(req.body, null, 2));

  if (!verifyElevenLabsSignature(req)) {
    console.warn('⚠️  Signature invalide');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = parseCallData(req.body);
    const { start, end } = buildDateTimes(data.dateStr, data.startTime);

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
      summary:     `RDV ${data.clientName} — ${data.serviceType}`,
      description,
      location:    data.clientAddress,
      start,
      end,
      colorId:     getColorId(data.urgency),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'email', minutes: 1440 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    console.log('✅ Événement créé:', response.data.htmlLink);

    return res.status(200).json({
      success:    true,
      event_id:   response.data.id,
      event_link: response.data.htmlLink,
      message:    `RDV confirmé pour ${data.clientName} le ${start.dateTime.replace('T', ' à ').slice(0, 16)}`,
    });

  } catch (err) {
    console.error('❌ Erreur création événement:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Route : enregistrer résumé d'appel (Sheets)
// ─────────────────────────────────────────────
app.post('/webhook/add-note', async (req, res) => {
  console.log('📝 Webhook add-note reçu:', JSON.stringify(req.body, null, 2));

  if (!verifyElevenLabsSignature(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHEET_ID) {
    return res.status(503).json({ error: 'GOOGLE_SHEET_ID non configuré' });
  }

  try {
    const data = parseCallData(req.body);
    const now  = new Date().toLocaleString('fr-FR', { timeZone: TIMEZONE });

    const row = [
      now,
      data.clientName,
      data.clientPhone,
      data.clientAddress,
      data.serviceType,
      data.urgency,
      data.notes,
      data.appointmentMade ? 'Oui' : 'Non',
      data.dateStr,
      data.startTime,
      data.eventLink,
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId:    SHEET_ID,
      range:            `${SHEET_TAB}!A:K`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [row] },
    });

    console.log('✅ Note ajoutée pour:', data.clientName);

    return res.status(200).json({
      success: true,
      message: `Résumé d'appel enregistré pour ${data.clientName}`,
    });

  } catch (err) {
    console.error('❌ Erreur ajout note:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// Route : RDV du jour
// ─────────────────────────────────────────────
app.get('/webhook/today-events', async (req, res) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin:      startOfDay.toISOString(),
      timeMax:      endOfDay.toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      fields:       'items(id,summary,start,end,location)',
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
  res.json({
    status:  'ok',
    service: 'AssistantPro Webhook',
    time:    new Date().toISOString(),
    features: { calendar: !!CALENDAR_ID, sheets: !!SHEET_ID },
  });
});

// ─────────────────────────────────────────────
// Démarrage
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AssistantPro Webhook démarré sur le port ${PORT}`);
});
