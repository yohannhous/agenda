require('dotenv').config();
const express    = require('express');
const dayjs      = require('dayjs');
const axios      = require('axios');
const { google } = require('googleapis');
const fs         = require('fs');
const FormData   = require('form-data');

require('dayjs/locale/fr');
dayjs.locale('fr');

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

const TIMEZONE = 'Indian/Reunion';
const TECH = { name: 'Yohann', calendarId: 'houssenalyy@gmail.com' };
const HORAIRES = [{ debut: 8, fin: 12 }, { debut: 14, fin: 18 }];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/calendar'] });
}

function genCreneaux(date, dureeMin) {
  const slots = [];
  const d = dayjs(date);
  if (d.day() === 0 || d.day() === 6) return slots;
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
    requestBody: { timeMin: debut.toISOString(), timeMax: fin.toISOString(), timeZone: TIMEZONE, items: [{ id: calendarId }] }
  });
  return (res.data.calendars[calendarId]?.busy || []).length === 0;
}

async function trouverCreneau(nbProduits, datePreferee = null) {
  const auth  = await getAuth();
  const duree = nbProduits >= 5 ? 60 : 40;
  let date = datePreferee ? dayjs(datePreferee) : dayjs().add(1, 'day');
  for (let i = 0; i < 30; i++) {
    for (const slot of genCreneaux(date.toDate(), duree)) {
      if (dayjs(slot).isBefore(dayjs())) continue;
      if (await crenauLibre(auth, TECH.calendarId, slot, duree)) return { slot, duree };
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
      summary: `RDV Devis SECUTECH - ${client.prenom} ${client.nom}`,
      description, location: `${client.adresse}, ${client.codePostal} ${client.ville}`,
      start: { dateTime: debut.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: fin.toISOString(),   timeZone: TIMEZONE },
      colorId: '2',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'email', minutes: 1440 }] }
    }
  });
  return { lien: event.data.htmlLink, debut: debut.format('dddd D MMMM YYYY [a] HH[h]mm'), fin: fin.format('HH[h]mm') };
}

async function getYeastarToken() {
  const res = await axios.post(
    `https://${process.env.YEASTAR_URL}/openapi/v1.0/get_token`,
    { username: process.env.YEASTAR_CLIENT_ID, password: process.env.YEASTAR_CLIENT_SECRET },
    { headers: { 'User-Agent': 'OpenAPI', 'Content-Type': 'application/json' } }
  );
  const token = res.data.access_token || res.data.token;
  if (!token) throw new Error('Token introuvable: ' + JSON.stringify(res.data));
  return token;
}

async function getRecording(token, telephone) {
  // Unix timestamps — pas de probleme de format
  const endTime   = Math.floor(Date.now() / 1000);
  const startTime = endTime - (20 * 60); // 20 minutes en arriere

  console.log('Recherche recording Unix:', startTime, '->', endTime);
  console.log('Telephone:', telephone);

  const url = `https://${process.env.YEASTAR_URL}/openapi/v1.0/recording/search`;

  // Essai 1 : avec filtre caller
  const res1 = await axios.get(url, {
    headers: { 'User-Agent': 'OpenAPI' },
    params: { access_token: token, caller: telephone, start_time: startTime, end_time: endTime, page: 1, page_size: 5 }
  });
  console.log('Recording (avec caller):', JSON.stringify(res1.data).substring(0, 300));

  if (res1.data?.data?.length) return res1.data.data[0];

  // Essai 2 : avec call_from
  const res2 = await axios.get(url, {
    headers: { 'User-Agent': 'OpenAPI' },
    params: { access_token: token, call_from: telephone, start_time: startTime, end_time: endTime, page: 1, page_size: 5 }
  });
  console.log('Recording (call_from):', JSON.stringify(res2.data).substring(0, 300));

  if (res2.data?.data?.length) return res2.data.data[0];

  // Essai 3 : sans filtre telephone
  const res3 = await axios.get(url, {
    headers: { 'User-Agent': 'OpenAPI' },
    params: { access_token: token, start_time: startTime, end_time: endTime, page: 1, page_size: 10 }
  });
  console.log('Recording (sans filtre):', JSON.stringify(res3.data).substring(0, 500));

  const recs = res3.data?.data || [];
  if (!recs.length) return null;

  // Trouver l enregistrement du bon appelant
  const match = recs.find(r =>
    r.call_from?.includes(telephone.replace('+', '')) ||
    r.call_from_number?.includes(telephone.replace('+', '')) ||
    telephone.includes(r.call_from_number?.replace('+', '') || 'XXXXX')
  );
  return match || recs[0];
}

async function downloadAndTranscribe(token, recording) {
  console.log('Recording trouve:', JSON.stringify(recording).substring(0, 300));
  const fileName = recording?.file || recording?.file_name || recording?.filename;
  if (!fileName) { console.log('Pas de fichier trouve'); return null; }

  // Telecharger l URL
  const dlRes = await axios.get(
    `https://${process.env.YEASTAR_URL}/openapi/v1.0/recording/download`,
    { headers: { 'User-Agent': 'OpenAPI' }, params: { access_token: token, file_name: fileName } }
  );
  console.log('Download URL response:', JSON.stringify(dlRes.data).substring(0, 300));

  const downloadUrl = dlRes.data?.data?.download_url || dlRes.data?.download_url;
  if (!downloadUrl) { console.log('URL de download introuvable'); return null; }

  console.log('Telechargement audio...');
  const audioRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const tmpPath  = `/tmp/rec_${Date.now()}.wav`;
  fs.writeFileSync(tmpPath, Buffer.from(audioRes.data));
  console.log('Audio telecharge:', tmpPath, Buffer.from(audioRes.data).length, 'bytes');

  // Transcrire avec Whisper
  const form = new FormData();
  form.append('file', fs.createReadStream(tmpPath), { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'whisper-1');
  form.append('language', 'fr');

  const whisperRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    maxContentLength: Infinity, maxBodyLength: Infinity, timeout: 60000
  });

  fs.unlinkSync(tmpPath);
  console.log('Transcription:', whisperRes.data?.text?.substring(0, 300));
  return whisperRes.data?.text || null;
}

async function extraireInfos(transcription, telephone) {
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: `Extrais les infos de cet appel SECUTECH en JSON sans markdown :
{"prenom":null,"nom":null,"telephone":null,"adresse":null,"codePostal":null,"ville":null,"demande":null,"nbProduits":1,"notes":null,"rdvSouhaite":false}` },
      { role: 'user', content: `Transcription:\n${transcription}\nTel: ${telephone}` }
    ], temperature: 0
  }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
  return JSON.parse(res.data.choices[0].message.content);
}

async function traiterAppel(telephone) {
  console.log('Traitement appel:', telephone);
  await new Promise(r => setTimeout(r, 20000));

  const token = await getYeastarToken();
  console.log('Token OK');

  const recording = await getRecording(token, telephone);
  if (!recording) { console.log('Aucun recording trouve'); return; }

  const transcription = await downloadAndTranscribe(token, recording);
  if (!transcription || transcription.length < 20) { console.log('Transcription vide'); return; }

  const infos = await extraireInfos(transcription, telephone);
  console.log('Infos:', infos);

  if (!infos.rdvSouhaite || !infos.prenom || !infos.adresse || !infos.ville) {
    console.log('Pas de RDV a creer'); return;
  }

  const dispo = await trouverCreneau(infos.nbProduits || 1);
  if (!dispo) { console.log('Aucun creneau'); return; }

  const rdv = await creerRDV({
    slot: dispo.slot, duree: dispo.duree,
    client: { prenom: infos.prenom || 'Inconnu', nom: infos.nom || '', telephone: infos.telephone || telephone, adresse: infos.adresse, codePostal: infos.codePostal || '', ville: infos.ville, demande: infos.demande || '', notes: infos.notes || '' }
  });
  console.log('RDV cree:', rdv.debut, rdv.lien);
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'SECUTECH Booking API' }));

app.post('/webhook', async (req, res) => {
  console.log('Webhook:', JSON.stringify(req.body).substring(0, 200));
  res.json({ success: true });
  try {
    const msg = req.body?.msg ? JSON.parse(req.body.msg) : req.body;
    const telephone = msg?.call_from || msg?.caller || '';
    if (telephone) traiterAppel(telephone).catch(e => console.error('Erreur:', e.message));
  } catch (e) { console.error('Parse error:', e.message); }
});

app.post('/rdv', async (req, res) => {
  const { prenom, nom, telephone, adresse, codePostal, ville, demande, nbProduits, notes, datePreferee } = req.body;
  const m = ['prenom','nom','telephone','adresse','codePostal','ville','demande'].filter(k => !req.body[k]);
  if (nbProduits === undefined) m.push('nbProduits');
  if (m.length) return res.status(400).json({ success: false, error: 'Champs manquants', m });
  try {
    const dispo = await trouverCreneau(nbProduits, datePreferee || null);
    if (!dispo) return res.status(503).json({ success: false, error: 'Aucun creneau' });
    const rdv = await creerRDV({ slot: dispo.slot, duree: dispo.duree, client: { prenom, nom, telephone, adresse, codePostal, ville, demande, notes: notes || '' } });
    return res.json({ success: true, rdv: { technicien: TECH.name, debut: rdv.debut, duree: `${dispo.duree} min`, lien: rdv.lien }, messageClient: `Parfait ${prenom} ! RDV confirme le ${rdv.debut}.` });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`SECUTECH Booking API port ${PORT}`));
