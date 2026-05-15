require('dotenv').config();
const express  = require('express');
const dayjs    = require('dayjs');
const axios    = require('axios');
const { google } = require('googleapis');

require('dayjs/locale/fr');
dayjs.locale('fr');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

// ─── Configuration ────────────────────────────────────────────
const TIMEZONE = 'Indian/Reunion';
const TECH = {
  name:       'Yohann',
  calendarId: 'houssenalyy@gmail.com'
};

// Horaires lundi-vendredi
const HORAIRES = [
  { debut: 8,  fin: 12 },
  { debut: 14, fin: 18 }
];

// ─── Auth Google ──────────────────────────────────────────────
function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}

// ─── Générer les créneaux d'une journée ───────────────────────
function genCreneaux(date, dureeMin) {
  const slots = [];
  const d = dayjs(date);
  const jour = d.day(); // 0=dim, 6=sam
  if (jour === 0 || jour === 6) return slots;

  for (const h of HORAIRES) {
    let cur = d.hour(h.debut).minute(0).second(0).millisecond(0);
    const fin = d.hour(h.fin).minute(0).second(0).millisecond(0);
    while (cur.add(dureeMin, 'minute').isBefore(fin) || cur.add(dureeMin, 'minute').isSame(fin)) {
      slots.push(cur.toDate());
      cur = cur.add(dureeMin, 'minute');
    }
  }
  return slots;
}

// ─── Vérifier si un créneau est libre ─────────────────────────
async function crenauLibre(auth, calendarId, debut, dureeMin) {
  const calendar = google.calendar({ version: 'v3', auth });
  const fin = dayjs(debut).add(dureeMin, 'minute').toDate();

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: debut.toISOString(),
      timeMax: fin.toISOString(),
      timeZone: TIMEZONE,
      items: [{ id: calendarId }]
    }
  });

  const busy = res.data.calendars[calendarId]?.busy || [];
  return busy.length === 0;
}

// ─── Trouver le premier créneau dispo ─────────────────────────
async function trouverCreneau(nbProduits, datePreferee = null) {
  const auth  = await getAuth();
  const duree = nbProduits >= 5 ? 60 : 40;

  let date = datePreferee ? dayjs(datePreferee) : dayjs().add(1, 'day');

  for (let i = 0; i < 30; i++) {
    const slots = genCreneaux(date.toDate(), duree);
    for (const slot of slots) {
      if (dayjs(slot).isBefore(dayjs())) continue;
      const libre = await crenauLibre(auth, TECH.calendarId, slot, duree);
      if (libre) return { slot, duree };
    }
    date = date.add(1, 'day');
  }
  return null;
}

// ─── Créer le RDV dans Google Calendar ───────────────────────
async function creerRDV({ slot, duree, client }) {
  const auth     = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const debut = dayjs(slot);
  const fin   = debut.add(duree, 'minute');

  const description = [
    `👤 Client : ${client.prenom} ${client.nom}`,
    `📞 Téléphone : ${client.telephone}`,
    `📍 Adresse : ${client.adresse}, ${client.codePostal} ${client.ville}`,
    `🔧 Demande : ${client.demande}`,
    `⏱ Durée : ${duree} minutes`,
    client.notes ? `📝 Notes : ${client.notes}` : ''
  ].filter(Boolean).join('\n');

  const event = await calendar.events.insert({
    calendarId: TECH.calendarId,
    requestBody: {
      summary:     `RDV Devis SECUTECH — ${client.prenom} ${client.nom}`,
      description,
      location:    `${client.adresse}, ${client.codePostal} ${client.ville}`,
      start: { dateTime: debut.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: fin.toISOString(),   timeZone: TIMEZONE },
      colorId: '2',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'email', minutes: 1440 }
        ]
      }
    }
  });

  return {
    lien:  event.data.htmlLink,
    debut: debut.format('dddd D MMMM YYYY [à] HH[h]mm'),
    fin:   fin.format('HH[h]mm')
  };
}

// ─── Vérifier l'adresse (Nominatim) ──────────────────────────
async function verifierAdresse(adresse, codePostal, ville) {
  try {
    const q = encodeURIComponent(`${adresse} ${codePostal} ${ville} La Réunion`);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=re`;
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'SECUTECH-Booking/1.0 contact@secutech.re' }
    });
    if (!res.data.length) return { valide: false };
    return { valide: true, adresseFormatee: res.data[0].display_name };
  } catch {
    return { valide: false };
  }
}

// ─── Routes ───────────────────────────────────────────────────

// Santé
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SECUTECH Booking API' });
});

// Créer un RDV
// Body attendu :
// {
//   "prenom": "Marie",
//   "nom": "Dupont",
//   "telephone": "0692123456",
//   "adresse": "10 rue des fleurs",
//   "codePostal": "97400",
//   "ville": "Saint-Denis",
//   "demande": "Installation caméras + alarme",
//   "nbProduits": 3,
//   "notes": "",
//   "datePreferee": "2026-05-20"   (optionnel)
// }
app.post('/rdv', async (req, res) => {
  const { prenom, nom, telephone, adresse, codePostal, ville, demande, nbProduits, notes, datePreferee } = req.body;

  // Validation
  const manquants = [];
  if (!prenom)     manquants.push('prenom');
  if (!nom)        manquants.push('nom');
  if (!telephone)  manquants.push('telephone');
  if (!adresse)    manquants.push('adresse');
  if (!codePostal) manquants.push('codePostal');
  if (!ville)      manquants.push('ville');
  if (!demande)    manquants.push('demande');
  if (nbProduits === undefined) manquants.push('nbProduits');

  if (manquants.length) {
    return res.status(400).json({ success: false, error: 'Champs manquants', manquants });
  }

  try {
    // 1. Vérifier l'adresse
    const adresseCheck = await verifierAdresse(adresse, codePostal, ville);

    // 2. Trouver un créneau
    const dispo = await trouverCreneau(nbProduits, datePreferee || null);
    if (!dispo) {
      return res.status(503).json({ success: false, error: 'Aucun créneau disponible dans les 30 prochains jours' });
    }

    // 3. Créer le RDV
    const rdv = await creerRDV({
      slot:  dispo.slot,
      duree: dispo.duree,
      client: { prenom, nom, telephone, adresse, codePostal, ville, demande, notes: notes || '' }
    });

    return res.json({
      success: true,
      rdv: {
        technicien: TECH.name,
        debut:      rdv.debut,
        fin:        rdv.fin,
        duree:      `${dispo.duree} minutes`,
        adresse:    adresseCheck.valide ? adresseCheck.adresseFormatee : `${adresse}, ${codePostal} ${ville}`,
        lien:       rdv.lien
      },
      messageClient: `Parfait ${prenom} ! Votre rendez-vous est confirmé le ${rdv.debut}. Notre technicien ${TECH.name} sera chez vous au ${adresse}, ${codePostal} ${ville}. La visite durera environ ${dispo.duree} minutes. À très bientôt !`
    });

  } catch (err) {
    console.error('Erreur:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Trouver le prochain créneau disponible sans créer de RDV
// Query : ?nbProduits=3&date=2026-05-20
app.get('/creneau', async (req, res) => {
  const nbProduits = parseInt(req.query.nbProduits) || 1;
  const date       = req.query.date || null;

  try {
    const dispo = await trouverCreneau(nbProduits, date);
    if (!dispo) return res.status(503).json({ success: false, error: 'Aucun créneau disponible' });

    const debut = dayjs(dispo.slot).locale('fr').format('dddd D MMMM YYYY [à] HH[h]mm');
    return res.json({
      success: true,
      debut,
      duree: `${dispo.duree} minutes`,
      messageClient: `Le prochain créneau disponible est le ${debut}. Cela vous convient-il ?`
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ SECUTECH Booking API démarré sur le port ${PORT}`));
