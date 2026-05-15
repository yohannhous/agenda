require('dotenv').config();
const express    = require('express');
const dayjs      = require('dayjs');
const axios      = require('axios');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');

require('dayjs/locale/fr');
dayjs.locale('fr');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`, JSON.stringify(req.body).substring(0, 200));
  next();
});

const TIMEZONE = 'Indian/Reunion';
const TECH = {
  name:       'Yohann',
  calendarId: 'houssenalyy@gmail.com'
};

const HORAIRES = [
  { debut: 8,  fin: 12 },
  { debut: 14, fin: 18 }
];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/calendar']
  });
}

function genCreneaux(date, dureeMin) {
  const slots = [];
  const d = dayjs(date);
  const jour = d.day();
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

async function creerRDV({ slot, duree, client }) {
  const auth     = await getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const debut = dayjs(slot);
  const fin   = debut.add(duree, 'minute');
  const description = [
    `Client : ${client.prenom} ${client.nom}`,
    `Telephone : ${client.telephone}`,
    `Adresse : ${client.adresse}, ${client.codePostal} ${client.ville}`,
    `Demande : ${client.demande}`,
    `Duree : ${duree} minutes`,
    client.notes ? `Notes : ${client.notes}` : ''
  ].filter(Boolean).join('\n');
  const event = await calendar.events.insert({
    calendarId: TECH.calendarId,
    requestBody: {
      summary:     `RDV Devis SECUTECH - ${client.prenom} ${client.nom}`,
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
    debut: debut.format('dddd D MMMM YYYY [a] HH[h]mm'),
    fin:   fin.format('HH[h]mm')
  };
}

async function verifierAdresse(adresse, codePostal, ville) {
  try {
    const q = encodeURIComponent(`${adresse} ${codePostal} ${ville} La Reunion`);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1&countrycodes=re`;
    const res = await axios.get(url, { headers: { 'User-Agent': 'SECUTECH-Booking/1.0 contact@secutech.re' } });
    if (!res.data.length) return { valide: false };
    return { valide: true, adresseFormatee: res.data[0].display_name };
  } catch {
    return { valide: false };
  }
}

async function getYeastarToken() {
  const url = `https://${process.env.YEASTAR_URL}/openapi/v1.0/get_token`;
  const res = await axios.post(url, {
    username: process.env.YEASTAR_CLIENT_ID,
    password: process.env.YEASTAR_CLIENT_SECRET
  }, {
    headers: { 'User-Agent': 'OpenAPI', 'Content-Type': 'application/json' }
  });
  const token = res.data.access_token || res.data.token || res.data.data?.access_token;
  if (!token) throw new Error('Token introuvable: ' + JSON.stringify(res.data));
  console.log('Token Yeastar obtenu');
  return token;
}

async function getRecordingUrl(token, telephone) {
  const now = dayjs().add(4, 'hour');
  const startTime = now.subtract(15, 'minute').format('DD/MM/YYYY HH:mm:ss');
  const endTime   = now.add(2, 'minute').format('DD/MM/YYYY HH:mm:ss');

  console.log('Recherche enregistrement pour:', telephone);
  console.log('Periode:', startTime, '->', endTime);

  const url = `https://${process.env.YEASTAR_URL}/openapi/v1.0/recording/search`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'OpenAPI' },
    params: {
      access_token: token,
      caller:       telephone,
      start_time:   startTime,
      end_time:     endTime,
      page:         1,
      page_size:    5
    }
  });

  console.log('Recordings:', JSON.stringify(res.data).substring(0, 500));

  const recordings = res.data?.data || [];
  if (!recordings.length) {
    console.log('Aucun enregistrement trouve, essai sans filtre...');
    const res2 = await axios.get(url, {
      headers: { 'User-Agent': 'OpenAPI' },
      params: {
        access_token: token,
        start_time:   startTime,
        end_time:     endTime,
        page:         1,
        page_size:    5
      }
    });
    console.log('Recordings sans filtre:', JSON.stringify(res2.data).substring(0, 500));
    const recs2 = res2.data?.data || [];
    if (!recs2.length) return null;
    return recs2[0];
  }

  return recordings[0];
}

async function downloadRecording(token, recording) {
  const fileName = recording?.file_name || recording?.filename || recording?.name;
  console.log('Champs recording:', Object.keys(recording).join(', '));
  console.log('Fichier:', fileName);

  if (!fileName) return null;

  const url = `https://${process.env.YEASTAR_URL}/openapi/v1.0/recording/download`;
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'OpenAPI' },
    params: { access_token: token, file_name: fileName }
  });

  console.log('Download response:', JSON.stringify(res.data).substring(0, 300));
  return res.data?.data?.download_url || res.data?.download_url || null;
}

async function transcribeWithWhisper(audioUrl) {
  console.log('Transcription Whisper de:', audioUrl);

  // Telecharger le fichier audio
  const audioRes = await axios.get(audioUrl, { responseType: 'arraybuffer' });
  const audioBuffer = Buffer.from(audioRes.data);
  const tmpPath = `/tmp/recording_${Date.now()}.wav`;
  fs.writeFileSync(tmpPath, audioBuffer);

  // Envoyer a OpenAI Whisper
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath), { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  form.append('language', 'fr');

  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  fs.unlinkSync(tmpPath);
  console.log('Transcription Whisper:', res.data?.text?.substring(0, 200));
  return res.data?.text || null;
}

async function extraireInfosClient(transcription, telephone) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Tu es un assistant qui extrait des informations depuis la transcription d un appel telephonique SECUTECH.
Reponds UNIQUEMENT en JSON valide sans markdown :
{
  "prenom": "prenom du client",
  "nom": "nom du client",
  "telephone": "numero de telephone",
  "adresse": "numero et rue",
  "codePostal": "code postal",
  "ville": "ville",
  "demande": "resume des services demandes",
  "nbProduits": nombre entier de services demandes,
  "notes": "infos supplementaires",
  "rdvSouhaite": true ou false
}
Si une info est absente mets null.`
        },
        {
          role: 'user',
          content: `Transcription:\n\n${transcription}\n\nTelephone appelant: ${telephone || 'inconnu'}`
        }
      ],
      temperature: 0
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  const content = response.data.choices[0].message.content;
  return JSON.parse(content);
}

async function traiterAppel(telephone) {
  console.log(`Traitement appel depuis ${telephone}...`);

  // Attendre que l enregistrement soit disponible
  await new Promise(r => setTimeout(r, 20000));

  const token = await getYeastarToken();

  // Recuperer l enregistrement
  const recording = await getRecordingUrl(token, telephone);
  if (!recording) {
    console.log('Aucun enregistrement trouve');
    return;
  }

  // Obtenir l URL de telechargement
  const downloadUrl = await downloadRecording(token, recording);
  if (!downloadUrl) {
    console.log('URL de telechargement introuvable');
    return;
  }

  // Transcrire avec Whisper
  const transcription = await transcribeWithWhisper(downloadUrl);
  if (!transcription || transcription.length < 20) {
    console.log('Transcription vide');
    return;
  }

  // Extraire les infos
  const infos = await extraireInfosClient(transcription, telephone);
  console.log('Infos extraites:', infos);

  if (!infos.rdvSouhaite || !infos.prenom || !infos.adresse || !infos.ville) {
    console.log('Pas de RDV a creer');
    return;
  }

  // Trouver un creneau et creer le RDV
  const dispo = await trouverCreneau(infos.nbProduits || 1);
  if (!dispo) { console.log('Aucun creneau disponible'); return; }

  const rdv = await creerRDV({
    slot:  dispo.slot,
    duree: dispo.duree,
    client: {
      prenom:     infos.prenom    || 'Inconnu',
      nom:        infos.nom       || '',
      telephone:  infos.telephone || telephone,
      adresse:    infos.adresse,
      codePostal: infos.codePostal || '',
      ville:      infos.ville,
      demande:    infos.demande   || '',
      notes:      infos.notes     || ''
    }
  });

  console.log(`RDV cree : ${rdv.debut} — ${rdv.lien}`);
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'SECUTECH Booking API' });
});

app.post('/webhook', async (req, res) => {
  console.log('Webhook recu:', JSON.stringify(req.body).substring(0, 300));
  res.json({ success: true, message: 'Webhook recu' });

  try {
    const msg       = req.body?.msg ? JSON.parse(req.body.msg) : req.body;
    const telephone = msg?.call_from || msg?.caller || req.body?.caller || '';
    console.log(`Telephone: ${telephone}`);
    if (!telephone) { console.log('Pas de telephone'); return; }
    traiterAppel(telephone).catch(err => console.error('Erreur:', err.message));
  } catch (err) {
    console.error('Erreur parsing webhook:', err.message);
  }
});

app.post('/rdv', async (req, res) => {
  const { prenom, nom, telephone, adresse, codePostal, ville, demande, nbProduits, notes, datePreferee } = req.body;
  const manquants = [];
  if (!prenom)     manquants.push('prenom');
  if (!nom)        manquants.push('nom');
  if (!telephone)  manquants.push('telephone');
  if (!adresse)    manquants.push('adresse');
  if (!codePostal) manquants.push('codePostal');
  if (!ville)      manquants.push('ville');
  if (!demande)    manquants.push('demande');
  if (nbProduits === undefined) manquants.push('nbProduits');
  if (manquants.length) return res.status(400).json({ success: false, error: 'Champs manquants', manquants });

  try {
    const adresseCheck = await verifierAdresse(adresse, codePostal, ville);
    const dispo = await trouverCreneau(nbProduits, datePreferee || null);
    if (!dispo) return res.status(503).json({ success: false, error: 'Aucun creneau disponible' });
    const rdv = await creerRDV({ slot: dispo.slot, duree: dispo.duree, client: { prenom, nom, telephone, adresse, codePostal, ville, demande, notes: notes || '' } });
    return res.json({
      success: true,
      rdv: { technicien: TECH.name, debut: rdv.debut, fin: rdv.fin, duree: `${dispo.duree} minutes`, lien: rdv.lien },
      messageClient: `Parfait ${prenom} ! Votre rendez-vous est confirme le ${rdv.debut}. La visite durera environ ${dispo.duree} minutes.`
    });
  } catch (err) {
    console.error('Erreur:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/creneau', async (req, res) => {
  const nbProduits = parseInt(req.query.nbProduits) || 1;
  try {
    const dispo = await trouverCreneau(nbProduits, req.query.date || null);
    if (!dispo) return res.status(503).json({ success: false, error: 'Aucun creneau disponible' });
    const debut = dayjs(dispo.slot).locale('fr').format('dddd D MMMM YYYY [a] HH[h]mm');
    return res.json({ success: true, debut, duree: `${dispo.duree} minutes` });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => console.log(`SECUTECH Booking API demarre sur le port ${PORT}`));
